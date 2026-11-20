import { EDITING_API_ERRORS, EDITING_OPERATIONS, type EditingApiErrorCode, type EditingOperationDefinition, type EditingPageSnapshot, type EditingPageTarget } from "./editing-api.js";
import type { PageDocument } from "./types.js";
import { identifier, localeCode } from "./validation-utils.js";

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
export type EditingApiClient = {
  discover(signal?: AbortSignal): Promise<EditingApiDiscovery>;
  read(target: EditingPageTarget, signal?: AbortSignal): Promise<EditingPageSnapshot>;
  save(target: EditingPageTarget, expectedVersion: string, document: unknown, signal?: AbortSignal): Promise<EditingPageSaveResult>;
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

/** Studio GUI and machine clients can call the same host-owned JSON wire API through this React-free client. */
export function createPageEditingApiClient(options: EditingApiClientOptions): EditingApiClient {
  const origin = apiOrigin(options.origin), siteId = identifier(options.siteId, "$siteId"), basePath = apiBasePath(options.basePath), fetcher = options.fetch ?? fetch;
  const send = async (path: string, method: "GET" | "PUT", body: unknown, signal?: AbortSignal): Promise<{ response: Response; body: Record<string, unknown> }> => {
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
      if (!exactKeys(body, ["document", "version"]) || !isEditingApiVersion(body.version)) throw new EditingApiClientError("invalid_response", response.status);
      const document = parseEditingPageDocumentEnvelope(body.document);
      assertTarget(document, target);
      return { document, version: body.version };
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
    }
  };
  return client;
}

