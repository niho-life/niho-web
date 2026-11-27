import { PAGE_OPERATION_VERSIONS, pageNodesHaveNames, pageOperationUsesNodeNames, pageOperationWire, type EditingPageApplyConflict, type EditingPageApplyInput, type EditingPageApplyResult } from "./editing-page-operations.js";
import { EDITING_API_ERRORS, EDITING_OPERATIONS, PAGE_CMS_BINDINGS_CAPABILITY, PAGE_NODE_NAME_CAPABILITY, withPageCmsBindingsCapability, withPageNodeNameCapability, type EditingApiErrorCode, type EditingCmsOperationStatus, type EditingCmsPublishPlan, type EditingCmsTarget, type EditingDiscoveredOperation, type EditingPageCatalog, type EditingPageReleaseSetItem, type EditingPageReleaseSetItemResult, type EditingPageReleaseSetPlan, type EditingPageReleaseSetStatus, type EditingPageSnapshot, type EditingPageTarget } from "./editing-api.js";
import {
  SITE_STYLES_FEATURE, parseEditingSiteStylesEditRequest, parseEditingSiteStylesEditResponse,
  parseEditingSiteStylesPublishRequest, parseEditingSiteStylesPublishResponse, parseEditingSiteStylesSnapshot, siteStylesEdits,
  type EditingSiteStylesEditRequest, type EditingSiteStylesEditResult, type EditingSiteStylesPublishRequest, type EditingSiteStylesPublishResult,
} from "./editing-site-styles.js";
import { parseCmsPageBindings } from "./cms-page-bindings.js";
import { parsePageInspectQuery, type PageInspectQuery, type PageInspectView } from "./page-inspect.js";
import { parsePagePreviewIntent, type EditingPagePreviewIntent } from "./editing-page-preview.js";
import {
  editingLocalizationOperation, EDITING_LOCALIZATION_RESULT_BYTES, parseEditingLocalizationConflict,
  parseEditingLocalizationInput, parseEditingLocalizationResult,
  type EditingLocalizationInput, type EditingLocalizationOperationId, type EditingLocalizationResult,
} from "./editing-localization.js";
import { normalizePageChange, validatePageChangePlan } from "./editor-model.js";
import { EDITING_EDITOR_SNAPSHOT_ACCEPT, parseEditingPageEditorState, parseEditingPagePresentation } from "./editing-page-snapshot.js";
import type { BlockContracts, PageDocument } from "./types.js";
import type { EditorAdapter, EditorPage, EditorPageChange, EditorPageChangePlan, EditorPageChangeResult, EditorReleasePlan, EditorReleaseRequest, EditorSite } from "./editor-types.js";
import type { EditorBreakpointSettings, EditorBreakpointSettingsSaveResult, EditorBreakpointSettingsSnapshot } from "./editor-types.js";
import { identifier, localeCode } from "./validation-utils.js";
import { parseBreakpointSettings } from "./style-model.js";
import { parseRevisionPage, type EditorRevisionPage } from "./history.js";
import { parseSiteStyles, type SiteStyles } from "./site-styles.js";
import { parseSiteSettings, type SiteSettings } from "./pages.js";
import {
  parseAssetDeleteResult, parseAssetListResult, parseAssetReference, parseAssetRestoreResult, parseAssetUpdateResult,
  parseAssetUploadIntent, parseAssetUsages, parseResolvedAssets, type AssetDeleteResult, type AssetListQuery,
  type AssetReference, type AssetRestoreResult, type AssetUpdateRequest, type AssetUploadIntent, type AssetUsage, type ResolvedAssetMap
} from "./assets.js";
import {
  parseCollectionCreateResult, parseCollectionItemResult, parseCollectionListResult, parseCollectionPublishResult,
  parseCollectionSaveResult, parseCollectionSchemaResult, parseCollectionValues,
  type CollectionDefinition, type CollectionItem, type CollectionItemSummary, type CollectionValues
} from "./collection-model.js";

const MAX_RESPONSE_BYTES = EDITING_LOCALIZATION_RESULT_BYTES;
const LOCALIZATION_ERROR_STATUS: Record<EditingApiErrorCode, number> = {
  authentication_required: 401, duplicate_operation: 409, forbidden: 403, host_contract_violation: 502, host_failure: 503,
  invalid_cursor: 400, invalid_request: 400, method_not_allowed: 405, node_not_found: 404, not_found: 404, result_too_large: 413,
  site_publication_in_progress: 409, validation_failed: 422, version_conflict: 409,
};
const DOCUMENT_KEYS = ["schemaVersion", "siteId", "pageId", "locale", "revision", "title", "meta", "tokens", "textStyles", "body"] as const;

export type EditingApiClientOptions = {
  /** HTTPS API origin. HTTP is allowed only for loopback development hosts. */
  readonly origin: string | URL;
  readonly siteId: string;
  readonly basePath?: string;
  readonly headers?: HeadersInit | (() => HeadersInit);
  readonly credentials?: RequestCredentials;
  readonly fetch?: typeof fetch;
  /** Keep page/CLI discovery on the legacy wire shape; site.styles methods still negotiate explicitly. */
  readonly preferLegacyDiscovery?: boolean;
  /** Request a full editor snapshot and validate its presentation with the site's block contracts. */
  readonly editorSnapshot?: { readonly blocks?: BlockContracts };
};
export type { EditingLocalizationInput, EditingLocalizationOperationId, EditingLocalizationResult } from "./editing-localization.js";
export type { EditingPagePreviewIntent } from "./editing-page-preview.js";
export type {
  EditingSiteStylesEdit, EditingSiteStylesEditRequest, EditingSiteStylesEditResult,
  EditingSiteStylesPublishRequest, EditingSiteStylesPublishResult, EditingSiteStylesUsage,
} from "./editing-site-styles.js";
export type EditingApiDiscovery = { readonly apiVersion: "v1"; readonly siteId: string; readonly operations: readonly EditingDiscoveredOperation[] };
export function supportsPageNodeNames(discovery: EditingApiDiscovery, operationId: "pages.apply" | "pages.save"): boolean {
  return discovery.operations.some((operation) => operation.id === operationId
    && "capabilities" in operation && operation.capabilities.some((capability) => capability === PAGE_NODE_NAME_CAPABILITY));
}
export function supportsPageCmsBindings(discovery: EditingApiDiscovery): boolean {
  return discovery.operations.some((operation) => operation.id === "pages.apply"
    && "capabilities" in operation && operation.capabilities.some((capability) => capability === PAGE_CMS_BINDINGS_CAPABILITY));
}
export type EditingPageSaveResult = { readonly status: "saved"; readonly version: string; readonly document: PageDocument } | { readonly status: "conflict" };
export type EditingPageInspectionSnapshot = Readonly<Record<string, unknown>> & { readonly view: PageInspectView; readonly version: string; readonly componentsVersion?: string; readonly presentationVersion?: string };
export type EditingPagePublishResult = { readonly status: "released"; readonly operationId: string; readonly version: string; readonly document: PageDocument } | { readonly status: "conflict" };
export type EditingPageReleaseInput = Omit<EditorReleaseRequest, "target">;
export type EditingCmsSaveResult = { readonly status: "saved"; readonly item: CollectionItem } | { readonly status: "conflict"; readonly current: CollectionItem };
export type EditingCmsPublishResult = { readonly status: "published" | "publishing"; readonly operationId: string; readonly item: CollectionItem } | { readonly status: "conflict" };
export type EditingPageReleaseSetResult = { readonly status: "completed" | "publishing"; readonly operationId: string; readonly items: readonly EditingPageReleaseSetItemResult[] } | { readonly status: "conflict" };
export type EditingApiClient = {
  discover(signal?: AbortSignal): Promise<EditingApiDiscovery>;
  executeLocalization<Id extends EditingLocalizationOperationId>(
    operationId: Id, input: EditingLocalizationInput<Id>, signal?: AbortSignal,
  ): Promise<EditingLocalizationResult<Id>>;
  readPageCatalog(signal?: AbortSignal): Promise<EditingPageCatalog>;
  preparePageChange(change: EditorPageChange, expectedVersion: string, signal?: AbortSignal, operationId?: string): Promise<EditorPageChangePlan>;
  applyPageChange(plan: EditorPageChangePlan, signal?: AbortSignal): Promise<EditorPageChangeResult>;
  inspectPage(target: EditingPageTarget, query: PageInspectQuery, signal?: AbortSignal): Promise<EditingPageInspectionSnapshot>;
  listPageHistory(target: EditingPageTarget, cursor?: string, signal?: AbortSignal): Promise<EditorRevisionPage>;
  readPageHistoryRevision(target: EditingPageTarget, id: string, signal?: AbortSignal): Promise<{ readonly document: PageDocument; readonly siteStyles?: SiteStyles; readonly presentation?: unknown }>;
  createPagePreviewIntent(target: EditingPageTarget, signal?: AbortSignal): Promise<EditingPagePreviewIntent>;
  read(target: EditingPageTarget, signal?: AbortSignal): Promise<EditingPageSnapshot>;
  applyOperations(target: EditingPageTarget, input: EditingPageApplyInput, signal?: AbortSignal): Promise<EditingPageApplyResult | EditingPageApplyConflict>;
  save(target: EditingPageTarget, expectedVersion: string, document: unknown, signal?: AbortSignal): Promise<EditingPageSaveResult>;
  prepareRelease(target: EditingPageTarget, request: EditingPageReleaseInput, signal?: AbortSignal): Promise<EditorReleasePlan>;
  release(target: EditingPageTarget, plan: EditorReleasePlan, operationId: string, signal?: AbortSignal): Promise<EditingPagePublishResult>;
  preparePageReleaseSet(items: readonly EditingPageReleaseSetItem[], signal?: AbortSignal, operationId?: string): Promise<EditingPageReleaseSetPlan>;
  publishPageReleaseSet(plan: EditingPageReleaseSetPlan, signal?: AbortSignal): Promise<EditingPageReleaseSetResult>;
  pageReleaseSetStatus(operationId: string, signal?: AbortSignal): Promise<EditingPageReleaseSetStatus>;
  readBreakpointSettings(signal?: AbortSignal): Promise<EditorBreakpointSettingsSnapshot>;
  saveBreakpointSettings(expectedVersion: string, settings: EditorBreakpointSettings, signal?: AbortSignal): Promise<EditorBreakpointSettingsSaveResult>;
  readSiteStyles(signal?: AbortSignal): Promise<ReturnType<typeof parseEditingSiteStylesSnapshot>>;
  editSiteStyles(input: EditingSiteStylesEditRequest, signal?: AbortSignal): Promise<EditingSiteStylesEditResult>;
  publishSiteStyles(input: EditingSiteStylesPublishRequest, signal?: AbortSignal): Promise<EditingSiteStylesPublishResult>;
  readCmsSchema(signal?: AbortSignal): Promise<readonly CollectionDefinition[]>;
  listCmsItems(collectionId: string, signal?: AbortSignal): Promise<readonly CollectionItemSummary[]>;
  readCmsItem(target: EditingCmsTarget, signal?: AbortSignal): Promise<CollectionItem>;
  createCmsItem(collectionId: string, operationId: string, signal?: AbortSignal): Promise<CollectionItem>;
  saveCmsItem(target: EditingCmsTarget, expectedVersion: string, operationId: string, values: unknown, signal?: AbortSignal): Promise<EditingCmsSaveResult>;
  prepareCmsPublish(target: EditingCmsTarget, expectedVersion: string, operationId: string, signal?: AbortSignal, redirect?: boolean): Promise<EditingCmsPublishPlan>;
  publishCmsItem(plan: EditingCmsPublishPlan, signal?: AbortSignal): Promise<EditingCmsPublishResult>;
  cmsOperationStatus(operationId: string, signal?: AbortSignal): Promise<EditingCmsOperationStatus>;
  listAssets(query: Omit<AssetListQuery, "siteId">, signal?: AbortSignal): Promise<ReturnType<typeof parseAssetListResult>>;
  listAssetUsages(reference: AssetReference, signal?: AbortSignal): Promise<AssetUsage[]>;
  resolveAssets(references: readonly AssetReference[], signal?: AbortSignal): Promise<ResolvedAssetMap>;
  updateAsset(reference: AssetReference, expectedVersion: string, changes: AssetUpdateRequest["changes"], signal?: AbortSignal): Promise<ReturnType<typeof parseAssetUpdateResult>>;
  createAssetUploadIntent(input: { readonly name: string; readonly mimeType: string; readonly bytes: number; readonly folderId: string | null; readonly provider: string }, signal?: AbortSignal): Promise<AssetUploadIntent>;
  deleteAsset(reference: AssetReference, expectedVersion: string, signal?: AbortSignal): Promise<AssetDeleteResult>;
  restoreAsset(reference: AssetReference, expectedVersion: string, signal?: AbortSignal): Promise<AssetRestoreResult>;
};

/** Connect the common history API methods to the optional PageEditor history adapter slots. */
export function createEditingApiHistoryAdapter(client: Pick<EditingApiClient, "listPageHistory" | "readPageHistoryRevision">): Pick<EditorAdapter, "listRevisions" | "readRevision"> {
  return {
    listRevisions: ({ target, cursor }, signal) => client.listPageHistory(target, cursor, signal),
    readRevision: ({ target, id }, signal) => client.readPageHistoryRevision(target, id, signal)
  };
}

/**
 * Editor site-settings facade. Metadata remains host-owned; every style read/write is delegated to
 * the common site.styles API and uses its draft CAS version.
 */
export function createEditingApiSiteSettingsFacade(
  client: Pick<EditingApiClient, "readSiteStyles" | "editSiteStyles" | "publishSiteStyles">,
  siteId: string,
  metadata: Omit<SiteSettings, "tokens" | "textStyles">,
): Pick<EditorAdapter, "readSiteSettings" | "saveSiteSettings" | "publishSiteStyles" | "siteSettingsMetadataEditable"> {
  const stableMetadata = parseSiteSettings(metadata);
  const withoutStyles = (settings: SiteSettings): SiteSettings => {
    const copy = { ...settings }; delete copy.tokens; delete copy.textStyles; return copy;
  };
  return {
    siteSettingsMetadataEditable: false,
    async readSiteSettings(requestSiteId, signal) {
      if (requestSiteId !== siteId) throw new TypeError("site mismatch");
      const snapshot = await client.readSiteStyles(signal);
      return { version: snapshot.draft.version, settings: parseSiteSettings({ ...stableMetadata, ...snapshot.draft.styles }),
        publishedVersion: snapshot.published.version, publishedStyles: structuredClone(snapshot.published.styles) };
    },
    async saveSiteSettings(request, signal) {
      if (request.siteId !== siteId) throw new TypeError("site mismatch");
      const settings = parseSiteSettings(request.settings);
      if (JSON.stringify(withoutStyles(settings)) !== JSON.stringify(withoutStyles(stableMetadata))) {
        throw new TypeError("site metadata is not writable through site.styles");
      }
      const edits = siteStylesEdits(request.previousStyles ?? {}, parseSiteStyles(settings), request.styleRenames);
      if (!edits.length) throw new TypeError("site styles did not change");
      return client.editSiteStyles({ expectedVersion: request.expectedVersion, edits }, signal);
    },
    async publishSiteStyles(request, signal) {
      if (request.siteId !== siteId) throw new TypeError("site mismatch");
      return client.publishSiteStyles({ expectedDraftVersion: request.expectedDraftVersion, expectedPublishedVersion: request.expectedPublishedVersion }, signal);
    }
  };
}

/** A stable wire error; response bodies and host messages are intentionally not copied into its message. */
export class EditingApiClientError extends Error {
  constructor(readonly code: EditingApiErrorCode | "request_failed" | "invalid_response" | "response_too_large" | "transport_error" | "redirect_response", readonly status: number | null = null, readonly details?: unknown) {
    super(code);
    this.name = "EditingApiClientError";
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
export function isEditingApiVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);
}
/** Validate only the host-neutral PageDocument envelope. The host owns full validation with its block/library/style registry. */
export function parseEditingPageDocumentEnvelope(value: unknown): PageDocument {
  if (!plainRecord(value) || Object.keys(value).some((key) => !DOCUMENT_KEYS.includes(key as typeof DOCUMENT_KEYS[number]))) throw new EditingApiClientError("invalid_response");
  try {
    if (value.schemaVersion !== 1 || value.revision === undefined || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || typeof value.title !== "string"
      || !plainRecord(value.tokens) || !Array.isArray(value.body)
      || value.meta !== undefined && !plainRecord(value.meta) || value.textStyles !== undefined && !plainRecord(value.textStyles)) throw new Error("envelope");
    return {
      ...value,
      siteId: identifier(value.siteId, "$.siteId"),
      pageId: identifier(value.pageId, "$.pageId"),
      locale: localeCode(value.locale, "$.locale")
    } as unknown as PageDocument;
  } catch { throw new EditingApiClientError("invalid_response"); }
}
function parseEditingCatalogPage(value: unknown, siteId: string): EditorPage {
  if (!plainRecord(value) || Object.keys(value).some((key) => !["siteId", "pageId", "locale", "title", "path", "kind", "visibility", "published"].includes(key))
    || value.siteId !== siteId || typeof value.title !== "string" || !value.title.trim() || value.title.length > 300
    || value.path !== undefined && (typeof value.path !== "string" || value.path.length > 300 || /[\u0000-\u001f\u007f]/u.test(value.path))
    || value.kind !== undefined && !["page", "template", "shared"].includes(String(value.kind))
    || value.visibility !== undefined && !["public", "private"].includes(String(value.visibility))
    || value.published !== undefined && typeof value.published !== "boolean") throw new EditingApiClientError("invalid_response");
  try {
    return { siteId, pageId: identifier(value.pageId, "$page.pageId"), locale: localeCode(value.locale, "$page.locale"), title: value.title,
      ...(value.path === undefined ? {} : { path: value.path }), ...(value.kind === undefined ? {} : { kind: value.kind as NonNullable<EditorPage["kind"]> }),
      ...(value.visibility === undefined ? {} : { visibility: value.visibility as NonNullable<EditorPage["visibility"]> }), ...(value.published === undefined ? {} : { published: value.published }) };
  } catch { throw new EditingApiClientError("invalid_response"); }
}
function normalizedManagementChange(value: EditorPageChange, siteId: string): Exclude<EditorPageChange, { action: "duplicate" }> {
  if (!plainRecord(value)) throw new TypeError("invalid page change");
  if (value.action === "create" && !exactKeys(value, ["action", "siteId", "locale", "title", "path"])) throw new TypeError("invalid page change");
  if (value.action === "update" && (!exactKeys(value, ["action", "target", "title", "path"]) || !plainRecord(value.target)
    || !exactKeys(value.target, ["siteId", "pageId", "locale"]))) throw new TypeError("invalid page change");
  if (value.action === "visibility" && (!exactKeys(value, ["action", "target", "visibility"]) || !plainRecord(value.target)
    || !exactKeys(value.target, ["siteId", "pageId", "locale"]))) throw new TypeError("invalid page change");
  const change = normalizePageChange(value);
  const targetSiteId = change?.action === "create" ? change.siteId : change && change.action !== "duplicate" ? change.target.siteId : null;
  if (!change || change.action === "duplicate" || targetSiteId !== siteId) throw new TypeError("invalid page change");
  return change;
}
function managementSite(siteId: string, domain: unknown): EditorSite {
  if (typeof domain !== "string") throw new EditingApiClientError("invalid_response");
  try {
    const url = new URL(domain);
    if (url.protocol !== "https:" || url.origin !== domain || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("origin");
  } catch { throw new EditingApiClientError("invalid_response"); }
  return { id: siteId, name: siteId, domains: [domain] };
}
const PAGE_CHANGE_OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function apiOrigin(value: string | URL): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError("editing API origin must be an absolute URL"); }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TypeError("editing API origin must be HTTPS (or loopback HTTP)");
  }
  return url.origin;
}
function apiBasePath(value: string | undefined): string {
  const path = value ?? "/api/edit/v1";
  if (!/^\/[a-z0-9/_-]+$/u.test(path) || path.endsWith("/") || path.includes("//")) throw new TypeError("invalid editing API base path");
  return path;
}
function targetPath(target: EditingPageTarget, siteId: string): string {
  if (!plainRecord(target) || target.siteId !== siteId) throw new TypeError("editing API target site does not match the client");
  const safeSite = identifier(target.siteId, "$target.siteId");
  const pageId = identifier(target.pageId, "$target.pageId");
  const locale = localeCode(target.locale, "$target.locale");
  return `/sites/${encodeURIComponent(safeSite)}/operations/{operation}/${encodeURIComponent(pageId)}?locale=${encodeURIComponent(locale)}`;
}
const CMS_COLLECTION_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,79}$/u;
const CMS_ITEM_ID = /^[A-Za-z0-9_][A-Za-z0-9._~-]{0,127}$/u;
function cmsCollection(value: unknown): string {
  if (typeof value !== "string" || !CMS_COLLECTION_ID.test(value) || ["__proto__", "constructor", "prototype"].includes(value)) throw new TypeError("invalid CMS collection ID");
  return value;
}
function cmsItem(value: unknown): string {
  if (typeof value !== "string" || !CMS_ITEM_ID.test(value) || value === "." || value === ".." || ["__proto__", "constructor", "prototype"].includes(value)) throw new TypeError("invalid CMS item ID");
  return value;
}
function cmsTarget(target: EditingCmsTarget, siteId: string): EditingCmsTarget {
  if (!plainRecord(target) || target.siteId !== siteId) throw new TypeError("invalid CMS target");
  return { siteId, collectionId: cmsCollection(target.collectionId), itemId: cmsItem(target.itemId) };
}
function assetReference(value: unknown): AssetReference {
  try { return parseAssetReference(value); } catch { throw new TypeError("invalid asset reference"); }
}
async function responseJson(response: Response): Promise<Record<string, unknown>> {
  if (response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new EditingApiClientError("invalid_response", response.status);
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)) throw new EditingApiClientError("response_too_large", response.status);
  const reader = response.body?.getReader();
  if (!reader) throw new EditingApiClientError("invalid_response", response.status);
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new EditingApiClientError("response_too_large", response.status); }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!plainRecord(value)) throw new Error("response shape");
    return value;
  } catch { throw new EditingApiClientError("invalid_response", response.status); }
}
function apiFailure(body: Record<string, unknown>, status: number): EditingApiClientError {
  const code = EDITING_API_ERRORS.includes(body.error as EditingApiErrorCode) ? body.error as EditingApiErrorCode : "request_failed";
  const details = code === "validation_failed" && Array.isArray(body.fields) && body.fields.length <= 100
    && body.fields.every((field) => plainRecord(field) && exactKeys(field, ["field", "message"]) && typeof field.field === "string" && field.field.length <= 80
      && typeof field.message === "string" && field.message.length <= 400)
    ? body.fields.map((field) => ({ field: (field as Record<string, string>).field, message: (field as Record<string, string>).message })) : undefined;
  const operationFailure = code === "validation_failed" && typeof body.index === "number" && Number.isSafeInteger(body.index) && body.index >= 0 && body.index < 500
    && typeof body.reason === "string" && body.reason.length <= 400 ? { index: body.index, reason: body.reason } : undefined;
  return new EditingApiClientError(code, status, operationFailure ?? details);
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (plainRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
function responseEtag(response: Response): string | null {
  const etag = response.headers.get("ETag");
  return etag && etag.length <= 512 && !/[\r\n]/u.test(etag) ? etag : null;
}
function confirmsNotModified(response: Response, etag: string): boolean {
  return response.status === 304 && responseEtag(response) === etag;
}
function validDiscoveredOperation(value: unknown): value is EditingDiscoveredOperation {
  if (!plainRecord(value)) return false;
  const expected = EDITING_OPERATIONS.find((operation) => operation.id === value.id);
  if (!expected) return false;
  const capabilities = Array.isArray(value.capabilities) ? value.capabilities : [];
  let definition: EditingDiscoveredOperation = capabilities.includes(PAGE_CMS_BINDINGS_CAPABILITY) && (expected.id === "pages.apply" || expected.id === "pages.read" || expected.id === "pages.inspect")
    ? withPageCmsBindingsCapability(expected, capabilities.includes(PAGE_NODE_NAME_CAPABILITY))
    : capabilities.includes(PAGE_NODE_NAME_CAPABILITY) && (expected.id === "pages.apply" || expected.id === "pages.save")
    ? withPageNodeNameCapability(expected) : expected;
  return exactKeys(value, Object.keys(definition)) && stableJson(value) === stableJson(definition);
}
function assertTarget(document: PageDocument, target: EditingPageTarget): void {
  if (document.siteId !== target.siteId || document.pageId !== target.pageId || document.locale !== target.locale) throw new EditingApiClientError("invalid_response");
}
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function normalizePageReleaseSetItems(value: unknown, siteId: string): EditingPageReleaseSetItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) throw new TypeError("page release set must contain 1 to 50 items");
  const items: EditingPageReleaseSetItem[] = [], seen = new Set<string>();
  for (const raw of value) {
    if (!plainRecord(raw) || Object.keys(raw).some((key) => !["target", "expectedVersion", "componentsVersion", "presentationVersion"].includes(key))
      || !plainRecord(raw.target) || !exactKeys(raw.target, ["siteId", "pageId", "locale"]) || raw.target.siteId !== siteId
      || !isEditingApiVersion(raw.expectedVersion) || raw.componentsVersion !== undefined && !isEditingApiVersion(raw.componentsVersion)
      || raw.presentationVersion !== undefined && !isEditingApiVersion(raw.presentationVersion)) throw new TypeError("invalid page release set item");
    let target: EditingPageTarget;
    try { target = { siteId, pageId: identifier(raw.target.pageId, "$target.pageId"), locale: localeCode(raw.target.locale, "$target.locale") }; }
    catch { throw new TypeError("invalid page release set target"); }
    const key = `${target.pageId}\u0000${target.locale}`;
    if (seen.has(key)) throw new TypeError("duplicate page release set target");
    seen.add(key);
    items.push({ target, expectedVersion: raw.expectedVersion,
      ...(raw.componentsVersion === undefined ? {} : { componentsVersion: raw.componentsVersion }),
      ...(raw.presentationVersion === undefined ? {} : { presentationVersion: raw.presentationVersion }) });
  }
  return items;
}
function parsePageReleaseSetPlan(value: unknown, siteId: string, operationId: string, expectedItems: readonly EditingPageReleaseSetItem[]): EditingPageReleaseSetPlan {
  if (!plainRecord(value) || !exactKeys(value, ["siteId", "operationId", "confirmationToken", "domain", "items"])
    || value.siteId !== siteId || value.operationId !== operationId || !isEditingApiVersion(value.confirmationToken) || typeof value.domain !== "string") {
    throw new EditingApiClientError("invalid_response");
  }
  let items: EditingPageReleaseSetItem[], domain: URL;
  try { items = normalizePageReleaseSetItems(value.items, siteId); domain = new URL(value.domain); }
  catch { throw new EditingApiClientError("invalid_response"); }
  if (stableJson(items) !== stableJson(expectedItems) || domain.protocol !== "https:" || domain.origin !== value.domain || domain.username || domain.password
    || domain.pathname !== "/" || domain.search || domain.hash) throw new EditingApiClientError("invalid_response");
  return { siteId, operationId, confirmationToken: value.confirmationToken, domain: value.domain, items };
}
function parsePageReleaseSetResult(value: unknown, siteId: string, operationId: string, expectedItems?: readonly EditingPageReleaseSetItem[]): Exclude<EditingPageReleaseSetResult, { status: "conflict" }> {
  if (!plainRecord(value) || !exactKeys(value, ["status", "operationId", "items"]) || value.operationId !== operationId
    || value.status !== "completed" && value.status !== "publishing" || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 50
    || expectedItems && value.items.length !== expectedItems.length) throw new EditingApiClientError("invalid_response");
  const seen = new Set<string>(), items: EditingPageReleaseSetItemResult[] = [];
  let hasPending = false;
  for (const [index, raw] of value.items.entries()) {
    if (!plainRecord(raw) || !plainRecord(raw.target) || !exactKeys(raw.target, ["siteId", "pageId", "locale"]) || raw.target.siteId !== siteId) {
      throw new EditingApiClientError("invalid_response");
    }
    let target: EditingPageTarget;
    try { target = { siteId, pageId: identifier(raw.target.pageId, "$target.pageId"), locale: localeCode(raw.target.locale, "$target.locale") }; }
    catch { throw new EditingApiClientError("invalid_response"); }
    const expected = expectedItems?.[index];
    if (expected && (target.pageId !== expected.target.pageId || target.locale !== expected.target.locale)) throw new EditingApiClientError("invalid_response");
    const key = `${target.pageId}\u0000${target.locale}`;
    if (seen.has(key)) throw new EditingApiClientError("invalid_response");
    seen.add(key);
    if (raw.status === "released") {
      if (!exactKeys(raw, ["target", "status", "version"]) || !isEditingApiVersion(raw.version)) throw new EditingApiClientError("invalid_response");
      items.push({ target, status: "released", version: raw.version });
    } else if (raw.status === "conflict" || raw.status === "pending") {
      if (!exactKeys(raw, ["target", "status"])) throw new EditingApiClientError("invalid_response");
      if (raw.status === "pending") hasPending = true;
      items.push({ target, status: raw.status });
    } else throw new EditingApiClientError("invalid_response");
  }
  if ((value.status === "publishing") !== hasPending) throw new EditingApiClientError("invalid_response");
  return { status: value.status, operationId, items };
}
function releaseRequestBody(value: EditingPageReleaseInput): Record<string, unknown> {
  const request = value as unknown as Record<string, unknown>;
  const allowed = ["expectedVersion", "action", "revision", "componentsVersion", "presentationVersion"];
  if (!plainRecord(request) || Object.keys(request).some((key) => !allowed.includes(key)) || !isEditingApiVersion(request.expectedVersion)
    || request.action !== "publish" && request.action !== "rollback"
    || request.action === "publish" && request.revision !== undefined
    || request.action === "rollback" && (!Number.isSafeInteger(request.revision) || Number(request.revision) < 1)
    || request.componentsVersion !== undefined && !isEditingApiVersion(request.componentsVersion)
    || request.presentationVersion !== undefined && !isEditingApiVersion(request.presentationVersion)) throw new TypeError("invalid release request");
  return request;
}
function parseReleasePlan(value: unknown, target: EditingPageTarget, request: EditingPageReleaseInput): EditorReleasePlan {
  const allowed = ["target", "expectedVersion", "action", "revision", "componentsVersion", "presentationVersion", "confirmationToken", "domain", "changes", "url", "affected"];
  if (!plainRecord(value) || Object.keys(value).some((key) => !allowed.includes(key)) || !plainRecord(value.target)
    || !exactKeys(value.target, ["siteId", "pageId", "locale"]) || value.target.siteId !== target.siteId || value.target.pageId !== target.pageId || value.target.locale !== target.locale
    || value.expectedVersion !== request.expectedVersion || value.action !== request.action || value.revision !== request.revision
    || value.componentsVersion !== request.componentsVersion || value.presentationVersion !== request.presentationVersion
    || value.action !== "publish" && value.action !== "rollback"
    || value.action === "publish" && value.revision !== undefined
    || value.action === "rollback" && (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1)
    || value.componentsVersion !== undefined && !isEditingApiVersion(value.componentsVersion)
    || value.presentationVersion !== undefined && !isEditingApiVersion(value.presentationVersion)
    || !isEditingApiVersion(value.confirmationToken) || typeof value.domain !== "string" || !Array.isArray(value.changes) || value.changes.length > 100
    || value.changes.some((change) => !plainRecord(change) || !exactKeys(change, ["path", "before", "after"])
      || typeof change.path !== "string" || change.path.length > 300 || typeof change.before !== "string" || change.before.length > 1200
      || typeof change.after !== "string" || change.after.length > 1200)) throw new EditingApiClientError("invalid_response");
  let domain: URL;
  try { domain = new URL(value.domain); } catch { throw new EditingApiClientError("invalid_response"); }
  if (domain.protocol !== "https:" || domain.origin !== value.domain || domain.username || domain.password || domain.pathname !== "/" || domain.search || domain.hash) throw new EditingApiClientError("invalid_response");
  if (value.url !== undefined && (typeof value.url !== "string" || !value.url.startsWith(`${value.domain}/`) || value.url.length > 2048)) throw new EditingApiClientError("invalid_response");
  if (value.affected !== undefined && (!Array.isArray(value.affected) || value.affected.length > 100 || value.affected.some((item) => !plainRecord(item)
    || Object.keys(item).some((key) => !["kind", "name", "detail"].includes(key)) || !["shared", "page", "site"].includes(String(item.kind))
    || typeof item.name !== "string" || !item.name || item.name.length > 120 || item.detail !== undefined && (typeof item.detail !== "string" || item.detail.length > 300)))) throw new EditingApiClientError("invalid_response");
  return value as unknown as EditorReleasePlan;
}

/** Studio GUI and machine clients can call the same host-owned JSON wire API through this React-free client. */
export function createPageEditingApiClient(options: EditingApiClientOptions): EditingApiClient {
  const origin = apiOrigin(options.origin), siteId = identifier(options.siteId, "$siteId"), basePath = apiBasePath(options.basePath), fetcher = options.fetch ?? fetch;
  const send = async (path: string, method: "GET" | "PUT" | "POST", body: unknown, signal?: AbortSignal, accept = "application/json", ifNoneMatch?: string): Promise<{ response: Response; body: Record<string, unknown> }> => {
    const headers = new Headers(typeof options.headers === "function" ? options.headers() : options.headers);
    headers.set("Accept", accept);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (ifNoneMatch) headers.set("If-None-Match", ifNoneMatch);
    const revalidateRead = method === "GET" && (/\/operations\/pages\.read\/[a-z][a-z0-9-]{0,59}(?:\?.*)?$/u.test(path)
      || /\/operations\/pages\.catalog(?:\?.*)?$/u.test(path));
    let response: Response;
    try {
      response = await fetcher(`${origin}${basePath}${path}`, {
        method, headers, credentials: options.credentials ?? "same-origin", cache: revalidateRead ? "no-cache" : "no-store", redirect: "manual", ...(signal ? { signal } : {}),
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new EditingApiClientError("transport_error");
    }
    if (response.status === 304) return { response, body: Object.create(null) as Record<string, unknown> };
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new EditingApiClientError("redirect_response", response.status);
    }
    return { response, body: await responseJson(response) };
  };
  const readCmsDefinition = async (collectionIdValue: unknown, signal?: AbortSignal): Promise<CollectionDefinition> => {
    const collectionId = cmsCollection(collectionIdValue);
    const { response, body } = await send(`/sites/${encodeURIComponent(siteId)}/operations/cms.schema`, "GET", undefined, signal);
    if (!response.ok) throw apiFailure(body, response.status);
    if (!exactKeys(body, ["collections"])) throw new EditingApiClientError("invalid_response", response.status);
    let collections: readonly CollectionDefinition[];
    try {
      const result = parseCollectionSchemaResult({ status: "ready", collections: body.collections });
      if (result.status !== "ready") throw new Error("forbidden");
      collections = result.collections;
    }
    catch { throw new EditingApiClientError("invalid_response", response.status); }
    const definition = collections.find((item) => item.id === collectionId);
    if (!definition) throw new EditingApiClientError("not_found", 404);
    return definition;
  };
  let discovered: EditingApiDiscovery | undefined;
  let siteStylesFeature = false;
  let siteStylesDiscovery: Promise<EditingApiDiscovery> | undefined;
  const pageReadCache = new Map<string, { etag: string; value: EditingPageSnapshot }>();
  let pageCatalogCache: { etag: string; value: EditingPageCatalog } | null = null;
  function rememberPageRead(key: string, entry: { etag: string; value: EditingPageSnapshot }): void {
    pageReadCache.delete(key);
    pageReadCache.set(key, entry);
    if (pageReadCache.size > 128) pageReadCache.delete(pageReadCache.keys().next().value!);
  }
  async function requirePageNodeNames(operationId: "pages.apply" | "pages.save", signal?: AbortSignal): Promise<void> {
    if (!supportsPageNodeNames(discovered ?? await client.discover(signal), operationId)) throw new EditingApiClientError("forbidden", 403);
  }
  async function requireSiteStylesOperation(id: string, signal?: AbortSignal): Promise<void> {
    let discovery: EditingApiDiscovery;
    if (siteStylesFeature && discovered) discovery = discovered;
    else {
      const pending = siteStylesDiscovery ?? (siteStylesDiscovery = performDiscovery(true, signal));
      void pending.then(() => {
        if (siteStylesDiscovery === pending) siteStylesDiscovery = undefined;
      }, () => {
        if (siteStylesDiscovery === pending) siteStylesDiscovery = undefined;
      });
      discovery = await pending;
    }
    if (!siteStylesFeature || !discovery.operations.some((operation) => operation.id === id)) throw new EditingApiClientError("not_found", 404);
  }
  async function performDiscovery(requestSiteStyles: boolean, signal?: AbortSignal): Promise<EditingApiDiscovery> {
    let result = await send(`/sites/${encodeURIComponent(siteId)}/capabilities${requestSiteStyles ? `?features=${SITE_STYLES_FEATURE}` : ""}`, "GET", undefined, signal);
    let negotiated = requestSiteStyles;
    if (requestSiteStyles && !result.response.ok && [400, 404, 405].includes(result.response.status)) {
      result = await send(`/sites/${encodeURIComponent(siteId)}/capabilities`, "GET", undefined, signal);
      negotiated = false;
    }
    const { response, body } = result;
    if (!response.ok) throw apiFailure(body, response.status);
    if (!exactKeys(body, ["apiVersion", "siteId", "operations"]) || body.apiVersion !== "v1" || body.siteId !== siteId || !Array.isArray(body.operations)
      || body.operations.length === 0 || body.operations.some((entry) => !validDiscoveredOperation(entry))
      || new Set(body.operations.map((entry) => (entry as Record<string, unknown>).id)).size !== body.operations.length) throw new EditingApiClientError("invalid_response", response.status);
    siteStylesFeature = negotiated;
    discovered = body as unknown as EditingApiDiscovery;
    return discovered;
  }
  const client: EditingApiClient = {
    async executeLocalization<Id extends EditingLocalizationOperationId>(id: Id, value: EditingLocalizationInput<Id>, signal?: AbortSignal) {
      const operation = editingLocalizationOperation(id);
      if (!operation) throw new TypeError("unknown localization operation");
      let input: EditingLocalizationInput<Id>;
      try { input = parseEditingLocalizationInput(id, value); }
      catch { throw new TypeError("invalid localization input"); }
      let path = operation.path.replace("{siteId}", encodeURIComponent(siteId));
      let payload: unknown;
      if (operation.method === "GET") {
        const query = new URLSearchParams();
        for (const [name, entry] of Object.entries(input)) {
          if (typeof entry === "string") query.set(name, entry);
        }
        if (query.size) path += `?${query}`;
      } else {
        payload = { siteId, ...input };
      }
      const { response, body } = await send(path, operation.method, payload, signal);
      if (response.status === 409 && body.error === "version_conflict" && operation.errors.includes("version_conflict")) {
        try { return parseEditingLocalizationConflict<Id>(id, body, input) as unknown as EditingLocalizationResult<Id>; }
        catch { throw new EditingApiClientError("invalid_response", response.status); }
      }
      if (!response.ok) {
        const code = body.error;
        const errors = operation.errors;
        if (typeof code !== "string" || !exactKeys(body, ["error"]) || !errors.includes(code as EditingApiErrorCode)
          || response.status !== LOCALIZATION_ERROR_STATUS[code as EditingApiErrorCode]) {
          throw new EditingApiClientError("invalid_response", response.status);
        }
        throw new EditingApiClientError(code as EditingApiErrorCode, response.status);
      }
      try {
        if (response.status !== 200) throw new Error("unexpected success status");
        const result = parseEditingLocalizationResult(id, body, input);
        if (["conflict", "forbidden", "not_found", "invalid"].includes(result.status)) throw new Error("unexpected result status");
        return result as unknown as EditingLocalizationResult<Id>;
      } catch { throw new EditingApiClientError("invalid_response", response.status); }
    },
    async discover(signal) {
      return performDiscovery(options.preferLegacyDiscovery !== true, signal);
    },
    async readPageCatalog(signal) {
      const path = `/sites/${encodeURIComponent(siteId)}/operations/pages.catalog`;
      let result = await send(path, "GET", undefined, signal, "application/json", pageCatalogCache?.etag);
      if (pageCatalogCache && confirmsNotModified(result.response, pageCatalogCache.etag)) return structuredClone(pageCatalogCache.value);
      if (result.response.status === 304) result = await send(path, "GET", undefined, signal);
      const { response, body } = result;
      if (response.status === 304) throw new EditingApiClientError("invalid_response", response.status);
      if (!response.ok) throw apiFailure(body, response.status);
      if (!exactKeys(body, ["version", "pages"]) || !isEditingApiVersion(body.version) || !Array.isArray(body.pages) || body.pages.length > 500) {
        throw new EditingApiClientError("invalid_response", response.status);
      }
      const pages = body.pages.map((page) => parseEditingCatalogPage(page, siteId));
      if (new Set(pages.map((page) => `${page.pageId}\u0000${page.locale}`)).size !== pages.length) throw new EditingApiClientError("invalid_response", response.status);
      const value = { version: body.version, pages };
      const etag = responseEtag(response);
      pageCatalogCache = etag ? { etag, value: structuredClone(value) } : null;
      return structuredClone(value);
    },
    async preparePageChange(changeValue, expectedVersion, signal, requestedOperationId = crypto.randomUUID()) {
      const change = normalizedManagementChange(changeValue, siteId);
      if (!isEditingApiVersion(expectedVersion) || !PAGE_CHANGE_OPERATION_ID.test(requestedOperationId)) throw new TypeError("invalid page change request");
      const path = `/sites/${encodeURIComponent(siteId)}/operations/pages.change-prepare`;
      const { response, body } = await send(path, "POST", { expectedVersion, operationId: requestedOperationId, change }, signal);
      if (response.status === 409 && body.error === "version_conflict") throw new EditingApiClientError("version_conflict", 409);
      if (!response.ok) throw apiFailure(body, response.status);
      if (!exactKeys(body, ["plan"]) || !plainRecord(body.plan)
        || !exactKeys(body.plan, ["expectedVersion", "operationId", "change", "confirmationToken", "domain", "impact"])
        || body.plan.expectedVersion !== expectedVersion || body.plan.operationId !== requestedOperationId) throw new EditingApiClientError("invalid_response", response.status);
      const plan = validatePageChangePlan(body.plan, change, managementSite(siteId, body.plan.domain));
      if (plan.expectedVersion !== expectedVersion || plan.operationId !== requestedOperationId) throw new EditingApiClientError("invalid_response", response.status);
      return plan;
    },
    async applyPageChange(planValue, signal) {
      if (!plainRecord(planValue)) throw new TypeError("invalid page change plan");
      const source = planValue as unknown as Record<string, unknown>;
      if (!exactKeys(source, ["expectedVersion", "operationId", "change", "confirmationToken", "domain", "impact"])) throw new TypeError("invalid page change plan");
      if (!isEditingApiVersion(source.expectedVersion) || typeof source.operationId !== "string" || !PAGE_CHANGE_OPERATION_ID.test(source.operationId)) throw new TypeError("invalid page change plan");
      const change = normalizedManagementChange(source.change as EditorPageChange, siteId);
      const checked = validatePageChangePlan(source, change, managementSite(siteId, source.domain));
      if (!checked.expectedVersion || !checked.operationId) throw new TypeError("invalid page change plan");
      const path = `/sites/${encodeURIComponent(siteId)}/operations/pages.change-apply`;
      const { response, body } = await send(path, "POST", {
        expectedVersion: checked.expectedVersion, operationId: checked.operationId, confirmationToken: checked.confirmationToken, change: checked.change,
      }, signal);
      if (response.status === 409 && body.error === "version_conflict") return { status: "conflict" };
      if (!response.ok) throw apiFailure(body, response.status);
      if (!exactKeys(body, ["status", "operationId", "page"]) || body.status !== "applied" || body.operationId !== checked.operationId) {
        throw new EditingApiClientError("invalid_response", response.status);
      }
      const page = parseEditingCatalogPage(body.page, siteId);
      return { status: "applied", page, operationId: checked.operationId };
    },
    async inspectPage(target, queryValue, signal) {
      let query: PageInspectQuery | null;
      try { query = parsePageInspectQuery(queryValue); } catch { query = null; }
      if (!query) throw new TypeError("invalid page inspection query");
      const targetUrl = targetPath(target, siteId).replace("{operation}", "pages.inspect");
      const queryAt = targetUrl.indexOf("?");
      const params = new URLSearchParams(targetUrl.slice(queryAt + 1));
      for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
      const path = targetUrl.slice(0, queryAt + 1) + params.toString();
      const { response, body } = await send(path, "GET", undefined, signal);
      if (!response.ok) throw apiFailure(body, response.status);
      if (body.view !== query.view || !isEditingApiVersion(body.version)
        || body.componentsVersion !== undefined && !isEditingApiVersion(body.componentsVersion)
        || body.presentationVersion !== undefined && !isEditingApiVersion(body.presentationVersion)
        || body.nextCursor !== undefined && (typeof body.nextCursor !== "string" || body.nextCursor.length > 2048)) throw new EditingApiClientError("invalid_response", response.status);
      if (["outline", "find"].includes(query.view) && (!Array.isArray(body.items) || body.items.length > 1000
        || body.items.some((item) => !plainRecord(item) || typeof item.id !== "string"))) throw new EditingApiClientError("invalid_response", response.status);
      if (query.view === "outline" && !plainRecord(body.definitions)) throw new EditingApiClientError("invalid_response", response.status);
      if (query.view === "subtree" && (body.nodeId !== query.node || typeof body.complete !== "boolean"
        || body.complete && (!plainRecord(body.subtree) || body.items !== undefined || body.format !== undefined)
        || !body.complete && (body.format !== "path-nodes" || !Array.isArray(body.items) || body.items.length > 1000
          || body.items.some((item) => !plainRecord(item) || !Array.isArray(item.path) || !plainRecord(item.node))))) throw new EditingApiClientError("invalid_response", response.status);
      if (query.view === "effectiveStyle" && (body.nodeId !== query.node || !plainRecord(body.style))) throw new EditingApiClientError("invalid_response", response.status);
      if (body.cmsBindings != null) {
        try { body.cmsBindings = parseCmsPageBindings(body.cmsBindings, target); }
        catch { throw new EditingApiClientError("invalid_response", response.status); }
      }
      return body as EditingPageInspectionSnapshot;
    },
    async listPageHistory(target, cursor, signal) {
      if (cursor !== undefined && (typeof cursor !== "string" || cursor.length < 1 || cursor.length > 500 || /[\u0000-\u001f\u007f]/u.test(cursor))) throw new TypeError("invalid page history cursor");
      const targetUrl = targetPath(target, siteId).replace("{operation}", "pages.history"), queryAt = targetUrl.indexOf("?");
      const params = new URLSearchParams(targetUrl.slice(queryAt + 1));
      if (cursor !== undefined) params.set("cursor", cursor);
      const path = targetUrl.slice(0, queryAt + 1) + params.toString();
      const { response, body } = await send(path, "GET", undefined, signal);
      if (!response.ok) throw apiFailure(body, response.status);
      try { if (response.status !== 200) throw new Error("unexpected success status"); return parseRevisionPage(body); }
      catch { throw new EditingApiClientError("invalid_response", response.status); }
    },
    async readPageHistoryRevision(target, id, signal) {
      if (typeof id !== "string" || id.length < 1 || id.length > 200 || /[\u0000-\u001f\u007f]/u.test(id)) throw new TypeError("invalid page history revision ID");
      const path = targetPath(target, siteId).replace("{operation}", "pages.history-read");
      const { response, body } = await send(path, "POST", { id }, signal);
      if (!response.ok) throw apiFailure(body, response.status);
      if (response.status !== 200 || Object.keys(body).some((key) => !["document", "siteStyles", "presentation"].includes(key)) || !Object.hasOwn(body, "document")
        || body.siteStyles !== undefined && !plainRecord(body.siteStyles) || body.presentation !== undefined && !plainRecord(body.presentation)) throw new EditingApiClientError("invalid_response", response.status);
      try {
        const document = parseEditingPageDocumentEnvelope(body.document);
        assertTarget(document, target);
        const siteStyles = body.siteStyles === undefined ? undefined : parseSiteStyles(body.siteStyles as SiteStyles);
        return { document, ...(siteStyles === undefined ? {} : { siteStyles }), ...(body.presentation === undefined ? {} : { presentation: body.presentation }) };
      } catch { throw new EditingApiClientError("invalid_response", response.status); }
    },
    async createPagePreviewIntent(target, signal) {
      const path = targetPath(target, siteId).replace("{operation}", "pages.preview-intent");
      const { response, body } = await send(path, "POST", {}, signal);
      if (!response.ok) throw apiFailure(body, response.status);
      const intent = parsePagePreviewIntent(body, origin);
      if (!intent || response.status !== 200) throw new EditingApiClientError("invalid_response", response.status);
      return intent;
    },
    async read(target, signal) {
      const path = targetPath(target, siteId).replace("{operation}", "pages.read");
      const key = `${target.pageId}\u0000${target.locale}`;
      const cached = pageReadCache.get(key);
      const accept = options.editorSnapshot ? EDITING_EDITOR_SNAPSHOT_ACCEPT : "application/json";
      let result = await send(path, "GET", undefined, signal, accept, cached?.etag);
      if (cached && confirmsNotModified(result.response, cached.etag)) return structuredClone(cached.value);
      if (result.response.status === 304) result = await send(path, "GET", undefined, signal, accept);
      const { response, body } = result;
      if (response.status === 304) throw new EditingApiClientError("invalid_response", response.status);
      if (!response.ok) throw apiFailure(body, response.status);
      const dependencyFields = PAGE_OPERATION_VERSIONS;
      const dependencies = Object.fromEntries(dependencyFields.flatMap((key) => body[key] === undefined ? [] : [[key, body[key]]]));
      const snapshotKeys = [
        ...(body.cmsBindings === undefined ? [] : ["cmsBindings"]),
        ...(options.editorSnapshot && body.editorState !== undefined ? ["editorState"] : []),
        ...(options.editorSnapshot && body.presentation !== undefined ? ["presentation"] : [])
      ];
      if (!exactKeys(body, ["document", "version", ...Object.keys(dependencies), ...snapshotKeys]) || !isEditingApiVersion(body.version)
        || Object.values(dependencies).some((value) => !isEditingApiVersion(value))) throw new EditingApiClientError("invalid_response", response.status);
      const document = parseEditingPageDocumentEnvelope(body.document);
      assertTarget(document, target);
      let editorSnapshot: Pick<EditingPageSnapshot, "editorState" | "presentation"> = {};
      if (body.editorState !== undefined || body.presentation !== undefined) {
        try {
          const editorState = body.editorState === undefined ? undefined : parseEditingPageEditorState(body.editorState);
          const presentation = parseEditingPagePresentation(body.presentation, body.presentationVersion, document, options.editorSnapshot?.blocks);
          editorSnapshot = { ...(editorState ? { editorState } : {}), ...(presentation ? { presentation } : {}) };
        } catch { throw new EditingApiClientError("invalid_response", response.status); }
      }
      let cmsBindings: EditingPageSnapshot["cmsBindings"];
      try { cmsBindings = body.cmsBindings == null ? body.cmsBindings : parseCmsPageBindings(body.cmsBindings, target); }
      catch { throw new EditingApiClientError("invalid_response", response.status); }
      const value = { document, version: body.version, ...dependencies, ...editorSnapshot, ...(cmsBindings === undefined ? {} : { cmsBindings }) };
      const etag = responseEtag(response);
      if (etag) rememberPageRead(key, { etag, value: structuredClone(value) });
      else pageReadCache.delete(key);
      return structuredClone(value);
    },
    async applyOperations(target, input, signal) {
      const path = targetPath(target, siteId).replace("{operation}", "pages.apply");
      if (input.operations.some(pageOperationUsesNodeNames)) await requirePageNodeNames("pages.apply", signal);
      const wireInput = { ...input, operations: input.operations.map(pageOperationWire) };
      const { response, body } = await send(path, "POST", wireInput, signal);
      if (response.status === 409 && body.error === "version_conflict") {
        if (exactKeys(body, ["error"])) return { status: "conflict" };
        const conditions = ["rebase_supported", "preconditions", "node_exists", "parent_id", "old_value", "child_path"];
        const seen = new Set<string>();
        if (!exactKeys(body, ["error", "unmetPreconditions"]) || !Array.isArray(body.unmetPreconditions) || !body.unmetPreconditions.length || body.unmetPreconditions.length > input.operations.length * 2
          || body.unmetPreconditions.some((item) => {
            if (!plainRecord(item) || !exactKeys(item, ["index", "condition"])) return true;
            const index = item.index, condition = item.condition;
            if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= input.operations.length
              || typeof condition !== "string" || !conditions.includes(condition)) return true;
            const key = `${index}:${condition}`;
            if (seen.has(key)) return true;
            seen.add(key);
            return false;
          })) {
          throw new EditingApiClientError("invalid_response", response.status);
        }
        return { status: "conflict", unmetPreconditions: body.unmetPreconditions };
      }
      if (!response.ok) throw apiFailure(body, response.status);
      if (input.dryRun && body.status === "valid" && exactKeys(body, ["status", "diff", "touched"])
        && Array.isArray(body.diff) && body.diff.length <= 301 && Array.isArray(body.touched) && body.touched.length <= 10000
        && body.diff.every((item) => plainRecord(item) && exactKeys(item, ["path", "before", "after"]) && [item.path, item.before, item.after].every((value) => typeof value === "string"))
        && body.touched.every((item) => typeof item === "string")) {
        return { status: "valid", diff: body.diff, touched: body.touched };
      }
      if (input.dryRun || body.status !== "applied" || !exactKeys(body, ["status", "version", "revision", "document"])
        || !isEditingApiVersion(body.version) || body.version === input.baseVersion) throw new EditingApiClientError("invalid_response", response.status);
      const document = parseEditingPageDocumentEnvelope(body.document);
      assertTarget(document, target);
      if (body.revision !== document.revision) throw new EditingApiClientError("invalid_response", response.status);
      return { status: "applied", version: body.version, revision: document.revision, document };
    },
    async save(target, expectedVersion, documentValue, signal) {
      const path = targetPath(target, siteId).replace("{operation}", "pages.save");
      const document = parseEditingPageDocumentEnvelope(documentValue);
      assertTarget(document, target);
      if (!isEditingApiVersion(expectedVersion)) throw new TypeError("invalid editing API version");
      if (pageNodesHaveNames(document.body)) await requirePageNodeNames("pages.save", signal);
      const { response, body } = await send(path, "PUT", { expectedVersion, document }, signal);
      if (response.status === 409 && body.error === "version_conflict") return { status: "conflict" };
      if (!response.ok) throw apiFailure(body, response.status);
      if (!exactKeys(body, ["status", "version", "document"]) || body.status !== "saved" || !isEditingApiVersion(body.version)) throw new EditingApiClientError("invalid_response", response.status);
      const savedDocument = parseEditingPageDocumentEnvelope(body.document);
      assertTarget(savedDocument, target);
      return { status: "saved", version: body.version, document: savedDocument };
    },
    async prepareRelease(target, request, signal) {
      const path = targetPath(target, siteId).replace("{operation}", "pages.release-plan");
      const input = releaseRequestBody(request);
      const { response, body } = await send(path, "POST", input, signal);
      if (response.status === 409 && body.error === "version_conflict") throw new EditingApiClientError("version_conflict", 409);
      if (!response.ok) throw apiFailure(body, response.status);
      if (!exactKeys(body, ["plan"])) throw new EditingApiClientError("invalid_response", response.status);
      return parseReleasePlan(body.plan, target, request);
    },
    async release(target, plan, operationId, signal) {
      const path = targetPath(target, siteId).replace("{operation}", "pages.release");
      if (!plan || !plainRecord(plan) || !plainRecord(plan.target) || !OPERATION_ID.test(operationId)) throw new TypeError("invalid release plan");
      const request: EditingPageReleaseInput = {
        expectedVersion: String(plan.expectedVersion), action: plan.action as "publish" | "rollback",
        ...(plan.revision === undefined ? {} : { revision: Number(plan.revision) }),
        ...(plan.componentsVersion === undefined ? {} : { componentsVersion: String(plan.componentsVersion) }),
        ...(plan.presentationVersion === undefined ? {} : { presentationVersion: String(plan.presentationVersion) })
      };
      const safePlan = parseReleasePlan(plan, target, request);
      const { response, body } = await send(path, "POST", { expectedVersion: safePlan.expectedVersion, confirmationToken: safePlan.confirmationToken, operationId }, signal);
      if (response.status === 409 && body.error === "version_conflict") return { status: "conflict" };
      if (!response.ok) throw apiFailure(body, response.status);
      if (!exactKeys(body, ["status", "operationId", "version", "document"]) || body.status !== "released" || body.operationId !== operationId || !isEditingApiVersion(body.version)) throw new EditingApiClientError("invalid_response", response.status);
      const document = parseEditingPageDocumentEnvelope(body.document);
      assertTarget(document, target);
      return { status: "released", operationId, version: body.version, document };
    },
    async preparePageReleaseSet(itemsValue, signal, requestedOperationId = crypto.randomUUID()) {
      const items = normalizePageReleaseSetItems(itemsValue, siteId);
      if (!OPERATION_ID.test(requestedOperationId)) throw new TypeError("invalid page release set operation ID");
      const path = `/sites/${encodeURIComponent(siteId)}/operations/pages.release-set-plan`;
      const { response, body } = await send(path, "POST", { siteId, operationId: requestedOperationId, items }, signal);
      if (response.status === 409 && body.error === "version_conflict") throw new EditingApiClientError("version_conflict", 409);
      if (response.status === 409 && body.error === "duplicate_operation") throw new EditingApiClientError("duplicate_operation", 409);
      if (!response.ok) throw apiFailure(body, response.status);
      if (!exactKeys(body, ["plan"])) throw new EditingApiClientError("invalid_response", response.status);
      return parsePageReleaseSetPlan(body.plan, siteId, requestedOperationId, items);
    },
    async publishPageReleaseSet(planValue, signal) {
      if (!plainRecord(planValue) || typeof planValue.operationId !== "string" || !OPERATION_ID.test(planValue.operationId)) throw new TypeError("invalid page release set plan");
      const itemsValue = normalizePageReleaseSetItems(planValue.items, siteId);
      const plan = parsePageReleaseSetPlan(planValue, siteId, planValue.operationId, itemsValue);
      const path = `/sites/${encodeURIComponent(siteId)}/operations/pages.release-set`;
      const { response, body } = await send(path, "POST", { siteId, operationId: plan.operationId, confirmationToken: plan.confirmationToken, items: plan.items }, signal);
      if (response.status === 409 && body.error === "version_conflict") return { status: "conflict" };
      if (response.status === 409 && body.error === "duplicate_operation") throw new EditingApiClientError("duplicate_operation", 409);
      if (!response.ok) throw apiFailure(body, response.status);
      try { return parsePageReleaseSetResult(body, siteId, plan.operationId, plan.items); }
      catch (error) {
        if (error instanceof EditingApiClientError) throw new EditingApiClientError("invalid_response", response.status);
        throw error;
      }
    },
    async pageReleaseSetStatus(operationId, signal) {
      if (!OPERATION_ID.test(operationId)) throw new TypeError("invalid page release set operation ID");
      const { response, body } = await send(`/sites/${encodeURIComponent(siteId)}/operations/pages.release-set-status/${encodeURIComponent(operationId)}`, "GET", undefined, signal);
      if (!response.ok) throw apiFailure(body, response.status);
      if (body.operationId !== operationId || !["unknown", "received", "completed"].includes(String(body.status))) throw new EditingApiClientError("invalid_response", response.status);
      if (body.status !== "completed") {
        if (!exactKeys(body, ["status", "operationId"])) throw new EditingApiClientError("invalid_response", response.status);
        return body as EditingPageReleaseSetStatus;
      }
      if (!exactKeys(body, ["status", "operationId", "httpStatus", "result"]) || !Number.isInteger(body.httpStatus)
        || Number(body.httpStatus) < 100 || Number(body.httpStatus) > 599 || !plainRecord(body.result)) throw new EditingApiClientError("invalid_response", response.status);
      if (body.httpStatus === 200) {
        try { return { status: "completed", operationId, httpStatus: 200, result: parsePageReleaseSetResult(body.result, siteId, operationId) }; }
        catch { throw new EditingApiClientError("invalid_response", response.status); }
      }
      return body as EditingPageReleaseSetStatus;
    },
    async readBreakpointSettings(signal) {
      const path = `/sites/${encodeURIComponent(siteId)}/operations/site.breakpoints.read`;
      const { response, body } = await send(path, "GET", undefined, signal);
      if (!response.ok) throw apiFailure(body, response.status);
      if (!exactKeys(body, ["settings", "version"]) || !isEditingApiVersion(body.version)) throw new EditingApiClientError("invalid_response", response.status);
      try { return { settings: parseBreakpointSettings(body.settings), version: body.version }; }
      catch { throw new EditingApiClientError("invalid_response", response.status); }
    },
    async saveBreakpointSettings(expectedVersion, settings, signal) {
      if (!isEditingApiVersion(expectedVersion)) throw new TypeError("invalid expected version");
      let checked: EditorBreakpointSettings;
      try { checked = parseBreakpointSettings(settings); }
      catch { throw new TypeError("invalid breakpoint settings"); }
      const path = `/sites/${encodeURIComponent(siteId)}/operations/site.breakpoints.save`;
      const { response, body } = await send(path, "PUT", { expectedVersion, settings: checked }, signal);
      if (response.status === 409 && body.error === "version_conflict") return { status: "conflict" };
      if (!response.ok) throw apiFailure(body, response.status);
      if (!exactKeys(body, ["status", "version"]) || body.status !== "saved" || !isEditingApiVersion(body.version)) throw new EditingApiClientError("invalid_response", response.status);
      return { status: "saved", version: body.version };
    },
    async readSiteStyles(signal) {
      await requireSiteStylesOperation("site.styles.read", signal);
      const { response, body } = await send(`/sites/${encodeURIComponent(siteId)}/operations/site.styles.read`, "GET", undefined, signal);
      if (!response.ok) throw apiFailure(body, response.status);
      try { return parseEditingSiteStylesSnapshot(body); }
      catch { throw new EditingApiClientError("invalid_response", response.status); }
    },
    async editSiteStyles(inputValue, signal) {
      await requireSiteStylesOperation("site.styles.edit", signal);
      let input: EditingSiteStylesEditRequest;
      try { input = parseEditingSiteStylesEditRequest(inputValue); } catch { throw new TypeError("invalid site style edit request"); }
      const { response, body } = await send(`/sites/${encodeURIComponent(siteId)}/operations/site.styles.edit`, "PUT", input, signal);
      if (response.status === 409 && body.error === "version_conflict") return { status: "conflict" };
      if (!response.ok) throw apiFailure(body, response.status);
      try { return parseEditingSiteStylesEditResponse(body, input.expectedVersion); }
      catch { throw new EditingApiClientError("invalid_response", response.status); }
    },
    async publishSiteStyles(inputValue, signal) {
      await requireSiteStylesOperation("site.styles.publish", signal);
      let input: EditingSiteStylesPublishRequest;
      try { input = parseEditingSiteStylesPublishRequest(inputValue); } catch { throw new TypeError("invalid site style publish request"); }
      const { response, body } = await send(`/sites/${encodeURIComponent(siteId)}/operations/site.styles.publish`, "POST", input, signal);
      if (response.status === 409 && body.error === "version_conflict") return { status: "conflict" };
      if (!response.ok) throw apiFailure(body, response.status);
      try { return parseEditingSiteStylesPublishResponse(body, input.expectedPublishedVersion); }
      catch { throw new EditingApiClientError("invalid_response", response.status); }
    },
    async readCmsSchema(signal) {
      const { response, body } = await send(`/sites/${encodeURIComponent(siteId)}/operations/cms.schema`, "GET", undefined, signal);
      if (!response.ok) throw apiFailure(body, response.status);
      if (!exactKeys(body, ["collections"])) throw new EditingApiClientError("invalid_response", response.status);
      try {
        const result = parseCollectionSchemaResult({ status: "ready", collections: body.collections });
        if (result.status !== "ready") throw new Error("forbidden");
        return result.collections;
      }
      catch { throw new EditingApiClientError("invalid_response", response.status); }
    },
    async listCmsItems(collectionIdValue, signal) {
      const collectionId = cmsCollection(collectionIdValue);
      const { response, body } = await send(`/sites/${encodeURIComponent(siteId)}/operations/cms.list/${encodeURIComponent(collectionId)}`, "GET", undefined, signal);
      if (!response.ok) throw apiFailure(body, response.status);
      try {
        const result = parseCollectionListResult({ status: "ready", collectionId: body.collectionId, items: body.items }, collectionId);
        if (!exactKeys(body, ["collectionId", "items"])) throw new Error("shape");
        if (result.status !== "ready") throw new Error("forbidden");
        return result.items;
      } catch { throw new EditingApiClientError("invalid_response", response.status); }
    },
    async readCmsItem(targetValue, signal) {
      const target = cmsTarget(targetValue, siteId), definition = await readCmsDefinition(target.collectionId, signal);
      const { response, body } = await send(`/sites/${encodeURIComponent(siteId)}/operations/cms.read/${encodeURIComponent(target.collectionId)}/${encodeURIComponent(target.itemId)}`, "GET", undefined, signal);
      if (!response.ok) throw apiFailure(body, response.status);
      if (!exactKeys(body, ["item"])) throw new EditingApiClientError("invalid_response", response.status);
      try {
        const result = parseCollectionItemResult({ status: "ready", item: body.item }, definition, target.itemId);
        if (result.status !== "ready") throw new Error("not ready");
        return result.item;
      }
      catch { throw new EditingApiClientError("invalid_response", response.status); }
    },
    async createCmsItem(collectionIdValue, operationId, signal) {
      const collectionId = cmsCollection(collectionIdValue);
      if (!OPERATION_ID.test(operationId)) throw new TypeError("invalid CMS operation ID");
      const definition = await readCmsDefinition(collectionId, signal);
      const { response, body } = await send(`/sites/${encodeURIComponent(siteId)}/operations/cms.create/${encodeURIComponent(collectionId)}`, "POST", { operationId }, signal);
      if (!response.ok) throw apiFailure(body, response.status);
      if (!exactKeys(body, ["item"])) throw new EditingApiClientError("invalid_response", response.status);
      try {
        const result = parseCollectionCreateResult({ status: "created", item: body.item }, definition);
        if (result.status !== "created") throw new Error("not created");
        return result.item;
      }
      catch { throw new EditingApiClientError("invalid_response", response.status); }
    },
    async saveCmsItem(targetValue, expectedVersion, operationId, values, signal) {
      const target = cmsTarget(targetValue, siteId);
      if (!isEditingApiVersion(expectedVersion) || !OPERATION_ID.test(operationId)) throw new TypeError("invalid CMS save request");
      const definition = await readCmsDefinition(target.collectionId, signal);
      let normalizedValues: CollectionValues;
      try { normalizedValues = parseCollectionValues(values, definition); }
      catch { throw new TypeError("invalid CMS values"); }
      const { response, body } = await send(`/sites/${encodeURIComponent(siteId)}/operations/cms.save/${encodeURIComponent(target.collectionId)}/${encodeURIComponent(target.itemId)}`, "PUT", { expectedVersion, operationId, values: normalizedValues }, signal);
      if (response.status === 409 && body.error === "version_conflict") {
        if (!exactKeys(body, ["error", "current"])) throw new EditingApiClientError("invalid_response", response.status);
        try {
          const result = parseCollectionSaveResult({ status: "conflict", item: body.current }, definition, target.itemId);
          if (result.status !== "conflict") throw new Error("not conflict");
          return { status: "conflict", current: result.item };
        }
        catch { throw new EditingApiClientError("invalid_response", response.status); }
      }
      if (!response.ok) throw apiFailure(body, response.status);
      if (!exactKeys(body, ["status", "item"]) || body.status !== "saved") throw new EditingApiClientError("invalid_response", response.status);
      try {
        const result = parseCollectionSaveResult({ status: "saved", item: body.item }, definition, target.itemId);
        if (result.status !== "saved") throw new Error("not saved");
        return { status: "saved", item: result.item };
      }
      catch { throw new EditingApiClientError("invalid_response", response.status); }
    },
    async prepareCmsPublish(targetValue, expectedVersion, operationId, signal, redirect) {
      const target = cmsTarget(targetValue, siteId);
      if (!isEditingApiVersion(expectedVersion) || !OPERATION_ID.test(operationId) || redirect !== undefined && typeof redirect !== "boolean") throw new TypeError("invalid CMS publish request");
      const definition = await readCmsDefinition(target.collectionId, signal);
      const { response, body } = await send(`/sites/${encodeURIComponent(siteId)}/operations/cms.publish-plan/${encodeURIComponent(target.collectionId)}/${encodeURIComponent(target.itemId)}`, "POST",
        { expectedVersion, operationId, ...(redirect === undefined ? {} : { redirect }) }, signal);
      if (response.status === 409) throw apiFailure(body, response.status);
      if (!response.ok) throw apiFailure(body, response.status);
      if (!exactKeys(body, ["plan"]) || !plainRecord(body.plan)
        || !exactKeys(body.plan, body.plan.redirect === undefined ? ["target", "expectedVersion", "operationId", "confirmationToken", "item"] : ["target", "expectedVersion", "operationId", "confirmationToken", "item", "redirect"])) throw new EditingApiClientError("invalid_response", response.status);
      const plan = body.plan;
      if (!plainRecord(plan.target) || !exactKeys(plan.target, ["siteId", "collectionId", "itemId"]) || plan.target.siteId !== siteId
        || plan.target.collectionId !== target.collectionId || plan.target.itemId !== target.itemId || plan.expectedVersion !== expectedVersion
        || plan.operationId !== operationId || !isEditingApiVersion(plan.confirmationToken) || plan.redirect !== redirect) throw new EditingApiClientError("invalid_response", response.status);
      try {
        const itemResult = parseCollectionItemResult({ status: "ready", item: plan.item }, definition, target.itemId);
        if (itemResult.status !== "ready") throw new Error("not ready");
        return { target, expectedVersion, operationId, confirmationToken: plan.confirmationToken, item: itemResult.item,
          ...(plan.redirect === undefined ? {} : { redirect: plan.redirect as boolean }) };
      }
      catch { throw new EditingApiClientError("invalid_response", response.status); }
    },
    async publishCmsItem(planValue, signal) {
      if (!plainRecord(planValue) || !exactKeys(planValue, planValue.redirect === undefined ? ["target", "expectedVersion", "operationId", "confirmationToken", "item"] : ["target", "expectedVersion", "operationId", "confirmationToken", "item", "redirect"])) throw new TypeError("invalid CMS publish plan");
      const target = cmsTarget(planValue.target as EditingCmsTarget, siteId);
      if (!isEditingApiVersion(planValue.expectedVersion) || typeof planValue.operationId !== "string" || !OPERATION_ID.test(planValue.operationId)
        || !isEditingApiVersion(planValue.confirmationToken) || planValue.redirect !== undefined && typeof planValue.redirect !== "boolean") throw new TypeError("invalid CMS publish plan");
      const definition = await readCmsDefinition(target.collectionId, signal);
      try {
        const result = parseCollectionItemResult({ status: "ready", item: planValue.item }, definition, target.itemId);
        if (result.status !== "ready" || result.item.version !== planValue.expectedVersion) throw new Error("plan item mismatch");
      } catch { throw new TypeError("invalid CMS publish plan"); }
      const { response, body } = await send(`/sites/${encodeURIComponent(siteId)}/operations/cms.publish/${encodeURIComponent(target.collectionId)}/${encodeURIComponent(target.itemId)}`, "POST",
        { expectedVersion: planValue.expectedVersion, operationId: planValue.operationId, confirmationToken: planValue.confirmationToken,
          ...(planValue.redirect === undefined ? {} : { redirect: planValue.redirect }) }, signal);
      if (response.status === 409 && body.error === "version_conflict") return { status: "conflict" };
      if (!response.ok) throw apiFailure(body, response.status);
      if (!exactKeys(body, ["status", "operationId", "item"]) || (body.status !== "published" && body.status !== "publishing") || body.operationId !== planValue.operationId) throw new EditingApiClientError("invalid_response", response.status);
      try {
        const result = parseCollectionPublishResult({ status: body.status, item: body.item }, definition, target.itemId);
        if (result.status !== "published" && result.status !== "publishing") throw new Error("not published");
        return { status: result.status, operationId: body.operationId, item: result.item };
      }
      catch { throw new EditingApiClientError("invalid_response", response.status); }
    },
    async cmsOperationStatus(operationId, signal) {
      if (!OPERATION_ID.test(operationId)) throw new TypeError("invalid CMS operation ID");
      const { response, body } = await send(`/sites/${encodeURIComponent(siteId)}/operations/cms.operation-status/${encodeURIComponent(operationId)}`, "GET", undefined, signal);
      if (!response.ok) throw apiFailure(body, response.status);
      if (body.operationId !== operationId || !["unknown", "received", "completed"].includes(String(body.status))) throw new EditingApiClientError("invalid_response", response.status);
      if (body.status !== "completed") {
        if (!exactKeys(body, ["status", "operationId"])) throw new EditingApiClientError("invalid_response", response.status);
        return body as EditingCmsOperationStatus;
      }
      if (!exactKeys(body, ["status", "operationId", "httpStatus", "result"]) || !Number.isInteger(body.httpStatus) || Number(body.httpStatus) < 100 || Number(body.httpStatus) > 599 || !plainRecord(body.result)) {
        throw new EditingApiClientError("invalid_response", response.status);
      }
      return body as EditingCmsOperationStatus;
    },
    async listAssets(query, signal) {
      const allowed = ["search", "kind", "folderId", "limit", "cursor", "provider", "recent"];
      if (!plainRecord(query) || Object.keys(query).some((key) => !allowed.includes(key)) || typeof query.search !== "string" || query.search.length > 200
        || /[\u0000-\u001f\u007f]/u.test(query.search) || !["all", "image", "video", "pdf", "other"].includes(query.kind)
        || query.folderId !== null && typeof query.folderId !== "string" || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200
        || query.cursor !== undefined && (typeof query.cursor !== "string" || query.cursor.length < 1 || query.cursor.length > 500)
        || query.provider !== undefined && (typeof query.provider !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(query.provider))
        || query.recent !== undefined && typeof query.recent !== "boolean") throw new TypeError("invalid asset list query");
      const params = new URLSearchParams({ search: query.search, kind: query.kind, limit: String(query.limit) });
      if (query.folderId !== null) params.set("folderId", assetReference({ provider: "folder", id: query.folderId }).id);
      if (query.cursor !== undefined) params.set("cursor", query.cursor);
      if (query.provider !== undefined) params.set("provider", query.provider);
      if (query.recent !== undefined) params.set("recent", String(query.recent));
      const { response, body } = await send(`/sites/${encodeURIComponent(siteId)}/operations/assets.list?${params}`, "GET", undefined, signal);
      if (!response.ok) throw apiFailure(body, response.status);
      try {
        const result = parseAssetListResult(body, siteId);
        if (query.provider !== undefined && result.assets.some((asset) => asset.provider !== query.provider)) throw new Error("provider mismatch");
        return result;
      } catch { throw new EditingApiClientError("invalid_response", response.status); }
    },
    async listAssetUsages(referenceValue, signal) {
      const reference = assetReference(referenceValue);
      const path = `/sites/${encodeURIComponent(siteId)}/operations/assets.usages/${encodeURIComponent(reference.provider)}/${encodeURIComponent(reference.id)}`;
      const { response, body } = await send(path, "GET", undefined, signal);
      if (!response.ok) throw apiFailure(body, response.status);
      if (!exactKeys(body, ["usages"])) throw new EditingApiClientError("invalid_response", response.status);
      try { return parseAssetUsages(body.usages); } catch { throw new EditingApiClientError("invalid_response", response.status); }
    },
    async resolveAssets(referenceValues, signal) {
      if (!Array.isArray(referenceValues) || referenceValues.length > 5000) throw new TypeError("invalid asset references");
      const references = referenceValues.map(assetReference), requested = new Set(references.map(({ provider, id }) => `${provider}:${id}`));
      const { response, body } = await send(`/sites/${encodeURIComponent(siteId)}/operations/assets.resolve`, "POST", { references }, signal);
      if (!response.ok) throw apiFailure(body, response.status);
      if (!exactKeys(body, ["assets"])) throw new EditingApiClientError("invalid_response", response.status);
      try {
        const assets = parseResolvedAssets(body.assets);
        if (Object.keys(assets).some((key) => !requested.has(key))) throw new Error("unrequested asset");
        return assets;
      } catch { throw new EditingApiClientError("invalid_response", response.status); }
    },
    async updateAsset(referenceValue, expectedVersion, changes, signal) {
      const reference = assetReference(referenceValue);
      if (!isEditingApiVersion(expectedVersion) || !plainRecord(changes) || Object.keys(changes).some((key) => !["name", "alt", "folderId"].includes(key))
        || Object.keys(changes).length === 0 || Object.hasOwn(changes, "name") && (typeof changes.name !== "string" || !changes.name.trim() || changes.name.length > 200 || /[\u0000-\u001f\u007f]/u.test(changes.name))
        || Object.hasOwn(changes, "alt") && (typeof changes.alt !== "string" || changes.alt.length > 1000 || /[\u0000-\u001f\u007f]/u.test(changes.alt))
        || Object.hasOwn(changes, "folderId") && changes.folderId !== null && typeof changes.folderId !== "string") throw new TypeError("invalid asset update");
      const path = `/sites/${encodeURIComponent(siteId)}/operations/assets.update/${encodeURIComponent(reference.provider)}/${encodeURIComponent(reference.id)}`;
      const { response, body } = await send(path, "PUT", { expectedVersion, changes }, signal);
      if (!response.ok) throw apiFailure(body, response.status);
      try {
        const result = parseAssetUpdateResult(body, siteId);
        if (result.status === "saved" && (result.asset.provider !== reference.provider || result.asset.id !== reference.id)) throw new Error("asset mismatch");
        return result;
      } catch { throw new EditingApiClientError("invalid_response", response.status); }
    },
    async createAssetUploadIntent(input, signal) {
      if (!plainRecord(input) || !exactKeys(input, ["name", "mimeType", "bytes", "folderId", "provider"]) || typeof input.name !== "string" || !input.name.trim() || input.name.length > 200
        || /[\u0000-\u001f\u007f]/u.test(input.name) || typeof input.mimeType !== "string" || !/^[a-z]+\/[a-z0-9.+-]+$/u.test(input.mimeType)
        || !Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.folderId !== null && typeof input.folderId !== "string"
        || typeof input.provider !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(input.provider)) throw new TypeError("invalid asset upload intent request");
      const { response, body } = await send(`/sites/${encodeURIComponent(siteId)}/operations/assets.upload-intent`, "POST", input, signal);
      if (!response.ok) throw apiFailure(body, response.status);
      try { return parseAssetUploadIntent(body); } catch { throw new EditingApiClientError("invalid_response", response.status); }
    },
    async deleteAsset(referenceValue, expectedVersion, signal) {
      const reference = assetReference(referenceValue);
      if (!isEditingApiVersion(expectedVersion)) throw new TypeError("invalid expected asset version");
      const path = `/sites/${encodeURIComponent(siteId)}/operations/assets.delete/${encodeURIComponent(reference.provider)}/${encodeURIComponent(reference.id)}`;
      const { response, body } = await send(path, "POST", { expectedVersion }, signal);
      if (!response.ok) throw apiFailure(body, response.status);
      try { return parseAssetDeleteResult(body); } catch { throw new EditingApiClientError("invalid_response", response.status); }
    },
    async restoreAsset(referenceValue, expectedVersion, signal) {
      const reference = assetReference(referenceValue);
      if (!isEditingApiVersion(expectedVersion)) throw new TypeError("invalid expected asset version");
      const path = `/sites/${encodeURIComponent(siteId)}/operations/assets.restore/${encodeURIComponent(reference.provider)}/${encodeURIComponent(reference.id)}`;
      const { response, body } = await send(path, "POST", { expectedVersion }, signal);
      if (!response.ok) throw apiFailure(body, response.status);
      try { return parseAssetRestoreResult(body); } catch { throw new EditingApiClientError("invalid_response", response.status); }
    }
  };
  return client;
}
