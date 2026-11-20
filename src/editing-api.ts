import type { BlockContracts, ComponentLibrary, PageDocument } from "./types.js";
import { parsePageDocument } from "./document.js";
import { validateReleasePlan } from "./editor-model.js";
import type { EditorBreakpointSettings, EditorBreakpointSettingsSaveResult, EditorBreakpointSettingsSnapshot, EditorReleasePlan, EditorReleaseRequest, EditorSite } from "./editor-types.js";
import { identifier, localeCode } from "./validation-utils.js";
import type { SiteStyles } from "./site-styles.js";
import { parseBreakpointSettings } from "./style-model.js";

/** Stable errors returned by the host-neutral page editing wire contract. */
export const EDITING_API_ERRORS = Object.freeze([
  "authentication_required", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found", "version_conflict"
] as const);
export type EditingApiErrorCode = typeof EDITING_API_ERRORS[number];

export type EditingActor = {
  readonly kind: "human" | "machine";
  readonly subject: string;
  readonly delegatedBy?: string;
};
export type EditingPageTarget = {
  readonly siteId: string;
  readonly pageId: string;
  readonly locale: string;
};
export type EditingAuthorizationScope = { readonly siteId: string; readonly pageId?: string; readonly locale?: string };
export type EditingPageSnapshot = {
  readonly document: PageDocument;
  readonly version: string;
  readonly componentsVersion?: string;
  readonly presentationVersion?: string;
};
export type EditingPageSaveResult = { readonly status: "saved"; readonly version: string; readonly document: PageDocument } | { readonly status: "conflict" };
export type EditingPageReleasePrepareResult = { readonly status: "prepared"; readonly plan: EditorReleasePlan } | { readonly status: "conflict" };
export type EditingPagePublishResult = { readonly status: "released"; readonly operationId: string; readonly version: string; readonly document: PageDocument } | { readonly status: "conflict" };
export type PageEditingValidationContext = { readonly blocks?: BlockContracts; readonly components?: ComponentLibrary; readonly siteStyles?: SiteStyles };

export type JsonSchema = boolean | {
  readonly $ref?: string;
  readonly type?: string;
  readonly const?: string | number | boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly items?: JsonSchema;
  readonly enum?: readonly string[];
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly maxItems?: number;
};
export type EditingOperationDefinition = {
  readonly id: "pages.read" | "pages.save" | "pages.release-plan" | "pages.release" | "site.breakpoints.read" | "site.breakpoints.save";
  readonly capability: "pages.read" | "pages.edit" | "pages.publish" | "site.settings.read" | "site.settings.write";
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

/** Canonical resource operations for hosts to expose to GUI and machine clients. */
export const EDITING_OPERATIONS: readonly EditingOperationDefinition[] = Object.freeze([
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
  })
]);

export type PageEditingHostAdapter = {
  /** Host owns login/session/API-key verification. Return null for an unauthenticated request. */
  authenticate(request: Request): Promise<EditingActor | null>;
  /** Resolve permissions from the authenticated principal for each request. */
  authorize(actor: EditingActor, capability: EditingOperationDefinition["capability"], target: EditingAuthorizationScope): Promise<boolean>;
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
  /** Optional site settings share the same discovery, authentication, authorization and wire contract. */
  readBreakpointSettings?(actor: EditingActor, siteId: string): Promise<EditorBreakpointSettingsSnapshot | null>;
  saveBreakpointSettings?(actor: EditingActor, siteId: string, expectedVersion: string, settings: EditorBreakpointSettings): Promise<EditorBreakpointSettingsSaveResult>;
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
    && (actor.delegatedBy === undefined || validVersion(actor.delegatedBy));
}
function pageTarget(siteId: unknown, pageId: unknown, locale: unknown): EditingPageTarget | null {
  try { return { siteId: identifier(siteId, "$target.siteId"), pageId: identifier(pageId, "$target.pageId"), locale: localeCode(locale, "$target.locale") }; }
  catch { return null; }
}
async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > 4 * 1024 * 1024)) return null;
  if (!request.body) return null;
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 4 * 1024 * 1024) { await reader.cancel(); return null; }
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
  if (operation.id === "pages.release-plan" || operation.id === "pages.release") return typeof adapter.releaseSite === "function" && typeof adapter.preparePageRelease === "function" && typeof adapter.publishPage === "function";
  if (operation.id === "site.breakpoints.read") return typeof adapter.readBreakpointSettings === "function";
  if (operation.id === "site.breakpoints.save") return typeof adapter.saveBreakpointSettings === "function";
  return true;
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
        try { if (await adapter.authorize(actor, operation.capability, { siteId }) === true) operations.push(operation); }
        catch { return fail("host_failure", 503); }
      }
      if (operations.length === 0) return fail("forbidden", 403);
      return response({ apiVersion: "v1", siteId, operations });
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
