import { EDITING_API_ERRORS, EDITING_OPERATIONS, type EditingApiErrorCode, type EditingOperationDefinition, type EditingPageSnapshot, type EditingPageTarget } from "./editing-api.js";
import type { PageDocument } from "./types.js";
import type { EditorReleasePlan, EditorReleaseRequest } from "./editor-types.js";
import type { EditorBreakpointSettings, EditorBreakpointSettingsSaveResult, EditorBreakpointSettingsSnapshot } from "./editor-types.js";
import { identifier, localeCode } from "./validation-utils.js";
import { parseBreakpointSettings } from "./style-model.js";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DOCUMENT_KEYS = ["schemaVersion", "siteId", "pageId", "locale", "revision", "title", "meta", "tokens", "textStyles", "body"] as const;

export type EditingApiClientOptions = {
  /** HTTPS API origin. HTTP is allowed only for loopback development hosts. */
  readonly origin: string | URL;
  readonly siteId: string;
  readonly basePath?: string;
  readonly headers?: HeadersInit | (() => HeadersInit);
  readonly credentials?: RequestCredentials;
  readonly fetch?: typeof fetch;
};
export type EditingApiDiscovery = { readonly apiVersion: "v1"; readonly siteId: string; readonly operations: readonly EditingOperationDefinition[] };
export type EditingPageSaveResult = { readonly status: "saved"; readonly version: string; readonly document: PageDocument } | { readonly status: "conflict" };
export type EditingPagePublishResult = { readonly status: "released"; readonly operationId: string; readonly version: string; readonly document: PageDocument } | { readonly status: "conflict" };
export type EditingPageReleaseInput = Omit<EditorReleaseRequest, "target">;
export type EditingApiClient = {
  discover(signal?: AbortSignal): Promise<EditingApiDiscovery>;
  read(target: EditingPageTarget, signal?: AbortSignal): Promise<EditingPageSnapshot>;
  save(target: EditingPageTarget, expectedVersion: string, document: unknown, signal?: AbortSignal): Promise<EditingPageSaveResult>;
  prepareRelease(target: EditingPageTarget, request: EditingPageReleaseInput, signal?: AbortSignal): Promise<EditorReleasePlan>;
  release(target: EditingPageTarget, plan: EditorReleasePlan, operationId: string, signal?: AbortSignal): Promise<EditingPagePublishResult>;
  readBreakpointSettings(signal?: AbortSignal): Promise<EditorBreakpointSettingsSnapshot>;
  saveBreakpointSettings(expectedVersion: string, settings: EditorBreakpointSettings, signal?: AbortSignal): Promise<EditorBreakpointSettingsSaveResult>;
};

/** A stable wire error; response bodies and host messages are intentionally not copied into its message. */
export class EditingApiClientError extends Error {
  constructor(readonly code: EditingApiErrorCode | "request_failed" | "invalid_response" | "response_too_large" | "transport_error", readonly status: number | null = null) {
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
  return new EditingApiClientError(EDITING_API_ERRORS.includes(body.error as EditingApiErrorCode) ? body.error as EditingApiErrorCode : "request_failed", status);
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (plainRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
function validDiscoveredOperation(value: unknown): value is EditingOperationDefinition {
  if (!plainRecord(value) || !exactKeys(value, ["id", "capability", "method", "path", "inputSchema", "resultSchema", "errors"])) return false;
  const expected = EDITING_OPERATIONS.find((operation) => operation.id === value.id);
  return !!expected && value.capability === expected.capability && value.method === expected.method && value.path === expected.path
    && stableJson(value.inputSchema) === stableJson(expected.inputSchema) && stableJson(value.resultSchema) === stableJson(expected.resultSchema)
    && stableJson(value.errors) === stableJson(expected.errors);
}
function assertTarget(document: PageDocument, target: EditingPageTarget): void {
  if (document.siteId !== target.siteId || document.pageId !== target.pageId || document.locale !== target.locale) throw new EditingApiClientError("invalid_response");
}
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function releaseRequestBody(value: EditingPageReleaseInput): Record<string, unknown> {
  const request = value as unknown as Record<string, unknown>;
  const allowed = ["expectedVersion", "action", "revision", "componentsVersion", "presentationVersion"];
  if (!plainRecord(request) || Object.keys(request).some((key) => !allowed.includes(key)) || !isEditingApiVersion(request.expectedVersion)
    || request.action !== "publish" && request.action !== "rollback"
    || request.action === "publish" && request.revision !== undefined
    || request.action === "rollback" && (!Number.isSafeInteger(request.revision) || Number(request.revision) < 1)
    || request.componentsVersion !== undefined && !isEditingApiVersion(request.componentsVersion)
    || request.presentationVersion !== undefined && !isEditingApiVersion(request.presentationVersion)) throw new TypeError("invalid release request");
  return { ...request };
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
  const send = async (path: string, method: "GET" | "PUT" | "POST", body: unknown, signal?: AbortSignal): Promise<{ response: Response; body: Record<string, unknown> }> => {
    const headers = new Headers(typeof options.headers === "function" ? options.headers() : options.headers);
    headers.set("Accept", "application/json");
    if (body !== undefined) headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await fetcher(`${origin}${basePath}${path}`, {
        method, headers, credentials: options.credentials ?? "same-origin", cache: "no-store", redirect: "manual", ...(signal ? { signal } : {}),
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new EditingApiClientError("transport_error");
    }
    return { response, body: await responseJson(response) };
  };
  const client: EditingApiClient = {
    async discover(signal) {
      const { response, body } = await send(`/sites/${encodeURIComponent(siteId)}/capabilities`, "GET", undefined, signal);
      if (!response.ok) throw apiFailure(body, response.status);
      if (!exactKeys(body, ["apiVersion", "siteId", "operations"]) || body.apiVersion !== "v1" || body.siteId !== siteId || !Array.isArray(body.operations)
        || body.operations.length === 0 || body.operations.some((entry) => !validDiscoveredOperation(entry))
        || new Set(body.operations.map((entry) => (entry as Record<string, unknown>).id)).size !== body.operations.length) throw new EditingApiClientError("invalid_response", response.status);
      return body as unknown as EditingApiDiscovery;
    },
    async read(target, signal) {
      const path = targetPath(target, siteId).replace("{operation}", "pages.read");
      const { response, body } = await send(path, "GET", undefined, signal);
      if (!response.ok) throw apiFailure(body, response.status);
      const readKeys = ["document", "version", ...(body.componentsVersion === undefined ? [] : ["componentsVersion"]), ...(body.presentationVersion === undefined ? [] : ["presentationVersion"])];
      if (!exactKeys(body, readKeys) || !isEditingApiVersion(body.version)
        || body.componentsVersion !== undefined && !isEditingApiVersion(body.componentsVersion)
        || body.presentationVersion !== undefined && !isEditingApiVersion(body.presentationVersion)) throw new EditingApiClientError("invalid_response", response.status);
      const document = parseEditingPageDocumentEnvelope(body.document);
      assertTarget(document, target);
      return { document, version: body.version,
        ...(body.componentsVersion === undefined ? {} : { componentsVersion: body.componentsVersion }),
        ...(body.presentationVersion === undefined ? {} : { presentationVersion: body.presentationVersion }) };
    },
    async save(target, expectedVersion, documentValue, signal) {
      const path = targetPath(target, siteId).replace("{operation}", "pages.save");
      const document = parseEditingPageDocumentEnvelope(documentValue);
      assertTarget(document, target);
      if (!isEditingApiVersion(expectedVersion)) throw new TypeError("invalid editing API version");
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
    }
  };
  return client;
}

