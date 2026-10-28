import { parseProjectAliasPath, projectShortcutTarget } from "./project-routes.mjs";
declare const __STUDIO_INDEX_PATH__: string;
import { siteAdmin } from "./site-admin.mjs";
import { integrationIdentity, isTrustedEditorAction, resolveTrustedEditorApi, resolveTrustedEditorPage, type ResolvedTrustedIntegration } from "./integration-registry.mjs";
import { KAMAKURA_CATALOG_CONTRACT_ERROR_CODE, KAMAKURA_CATALOG_CONTRACT_ERROR_STATUS, KamakuraCatalogContractError, KAMAKURA_COMMON_PAGE_ID, KAMAKURA_EDITOR_SITE_ID, parseKamakuraCatalog } from "./kamakura-catalog.js";
import {
  KAMAKURA_CMS_IMAGE_TYPES, KAMAKURA_CMS_LIMITS, KAMAKURA_CMS_PROJECT_ID, KAMAKURA_CMS_SITE_ID, KAMAKURA_CMS_UPLOAD_ORIGIN, KAMAKURA_CMS_UPSTREAM_PREFIX,
  KAMAKURA_MEDIA_ORIGIN, KamakuraCmsContractError,
  isKamakuraCmsCollectionId, isKamakuraCmsItemId, isKamakuraCmsLine, isKamakuraCmsSitePath, isKamakuraCmsVersion, normalizeKamakuraCmsTimestamp,
  parseKamakuraCmsEnglishPublications,
  parseKamakuraCmsConflict, parseKamakuraCmsInvalid, parseKamakuraCmsItemEnvelope, parseKamakuraCmsList, parseKamakuraCmsListChange,
  parseKamakuraCmsListConflict, parseKamakuraCmsRemoved, parseKamakuraCmsSchema, parseKamakuraCmsUploadIntent, parseKamakuraCmsValues
} from "./kamakura-cms-contract.js";
import {
  KAMAKURA_LOCALIZATION_IMAGE_TYPES, KAMAKURA_LOCALIZATION_LIMITS, KAMAKURA_LOCALIZATION_PREVIEW_ORIGIN, KAMAKURA_LOCALIZATION_UPLOAD_ORIGIN,
  KAMAKURA_LOCALIZATION_UPSTREAM_PREFIX, isKamakuraLocalizationPreviewFrame, parseKamakuraLocalizationUploadIntent, parseKamakuraLocalizationUploadRefusal
} from "./kamakura-localization-contract.js";
import {
  LOCALIZATION_LIMITS, isLocalizationItemKey, isLocalizationOperationId, parseLocaleReleaseApplyResult, parseLocaleReleasePrepareResult, parseLocaleReleaseStateResult,
  parseLocalizationCatalogResult, parseLocalizationCommandResult, parseLocalizationItemResult, parseLocalizationJobResult, parseLocalizationListResult,
  parseLocalizationOverviewResult, parseLocalizationPreviewResult, parseLocalizationSettingsResult, parseLocalizationTranslationResult,
  type LocaleReleasePrepareInput
} from "../src/localization-workspace-model.js";
import { parseLocalizationOverlay, parseLocalizationValue, parseSiteLocalizationConfig } from "../src/localization.js";
import { DocumentValidationError } from "../src/validation-utils.js";
import { parseEnglishPublicationAccepted } from "../src/english-publication.js";

type D1Meta = { readonly changes?: number };
type D1Result<T> = { readonly results?: readonly T[]; readonly success: boolean; readonly meta?: D1Meta };
type D1Statement = {
  bind(...values: readonly unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1Result<T>>;
};
type D1Database = {
  prepare(query: string): D1Statement;
  batch<T>(statements: readonly D1Statement[]): Promise<readonly D1Result<T>[]>;
};
type AssetBinding = { fetch(request: Request): Promise<Response> };

export interface Env {
  readonly DB: D1Database;
  readonly ASSETS: AssetBinding;
  /** 同一 Cloudflare account の kamakura-site Worker。 */
  readonly KAMAKURA_SITE: AssetBinding;
  /** Cloudflare Access application JWTのissと完全一致するHTTPS origin。 */
  readonly ACCESS_ISSUER: string;
  /** Cloudflare Access applicationのAUD tag。 */
  readonly ACCESS_AUDIENCE: string;
  /** NIHO internal Studio bridgeと共有するbase64url HMAC key。 */
  readonly NIHO_STUDIO_BRIDGE_SECRET?: string;
  /** NIHO API stg の internal Studio bridge と共有する別のbase64url HMAC key。 */
  readonly NIHO_STUDIO_BRIDGE_SECRET_STG?: string;
  /** kamakura-site Studio bridgeと共有するbase64url HMAC key。 */
  readonly KAMAKURA_STUDIO_BRIDGE_SECRET?: string;
  /** kamakura-site の管理画面（CMS・翻訳）の https origin。Dashboard の中の枠で開く（kamakura-site#108 U1）。未設定なら枠を出さない。 */
  readonly KAMAKURA_ADMIN_ORIGIN?: string;
  /** "workspace" のときだけ、Dashboard の CMS を Studio のコレクション画面で開く。無い・ほかの値は従来の枠。 */
  readonly KAMAKURA_CMS_VIEW?: string;
  /** "workspace" のときだけ、Dashboard の翻訳を Studio の翻訳の画面で開く。無い・ほかの値は従来の枠。 */
  readonly KAMAKURA_TRANSLATIONS_VIEW?: string;
}

type Role = "owner" | "editor";
type AccessIdentity = { readonly subject: string; readonly email: string };
type JwtHeader = { readonly alg?: unknown; readonly kid?: unknown; readonly typ?: unknown };
type JwtClaims = {
  readonly iss?: unknown;
  readonly aud?: unknown;
  readonly sub?: unknown;
  readonly email?: unknown;
  readonly type?: unknown;
  readonly exp?: unknown;
  readonly iat?: unknown;
  readonly nbf?: unknown;
};
type JwksDocument = { readonly keys?: unknown };
type SigningJwk = JsonWebKey & { readonly kid?: string; readonly alg?: string; readonly use?: string };
type ProjectRow = {
  readonly project_id: string;
  readonly project_name: string;
  readonly site_id: string;
  readonly site_name: string;
  readonly public_origin: string | null;
  readonly display_name: string;
};
type DirectoryMemberRow = { readonly project_id: string; readonly display_name: string; readonly role: Role };
type AdminContextRow = { readonly project_name: string; readonly site_name: string };
type MemberRow = {
  readonly access_subject: string;
  readonly email: string | null;
  readonly role: Role;
  readonly display_name: string;
  readonly created_at: string;
};
type InvitationRow = {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly created_at: number;
  readonly expires_at: number;
  readonly status: "pending" | "expired" | "accepted" | "revoked";
};
type InvitationPreviewRow = {
  readonly project_name: string;
  readonly site_name: string;
  readonly role: Role;
  readonly expires_at: number;
};

const MAX_MUTATION_BODY_BYTES = 16 * 1024;
const MAX_EDITOR_SAVE_BODY_BYTES = 600 * 1024;
const MAX_EDITOR_RESPONSE_BYTES = 2 * 1024 * 1024;
const EDITOR_UPSTREAM_ORIGIN = "https://api.niho.life";
const EDITOR_STAGING_UPSTREAM_ORIGIN = "https://api-stg.niho.life";
const EDITOR_UPSTREAM_PREFIX = "/api/internal/studio/experience";
const EDITOR_PROJECT_ID = "project-experience";
const EDITOR_SITE_ID = "experience";
const EDITOR_TIMEOUT_MILLISECONDS = 12_000;
// 鎌倉の公開（release）は kamakura-site 側で GitHub への commit と公開後の読み直しまで行い、ほかの操作より長い。
// 12 秒では commit が済んでも応答が間に合わず「接続できません」になった（kamakura-site#109 の受入）。
const KAMAKURA_RELEASE_TIMEOUT_MILLISECONDS = 30_000;
const KAMAKURA_EDITOR_UPSTREAM_ORIGIN = "https://next-kamakura.niho.life";
const KAMAKURA_EDITOR_UPSTREAM_PREFIX = "/internal/studio/web-content";
const KAMAKURA_EDITOR_PROJECT_ID = "project-kamakura";
// Dashboard の公開情報（kamakura-site の worker/studio-overview.ts）。「_」始まりはページ ID と重ならない。
const KAMAKURA_OVERVIEW_UPSTREAM_PATH = `${KAMAKURA_EDITOR_UPSTREAM_PREFIX}/_site/overview`;
// Dashboard を待たせすぎない。kamakura-site 側は GitHub を 5 秒で諦めて手元の値だけで返す。
const KAMAKURA_OVERVIEW_TIMEOUT_MILLISECONDS = 8_000;
const KAMAKURA_OVERVIEW_MAX_RESPONSE_BYTES = 64 * 1024;
const DIRECTORY_OG_TIMEOUT_MILLISECONDS = 2_000;
const DIRECTORY_OG_MAX_RESPONSE_BYTES = 256 * 1024;
/** D1 の値だけでは fetch を許さない。Studio が接続済みの公開 origin と、その OG 画像 origin を固定する。 */
const DIRECTORY_OG_SOURCES = new Map<string, ReadonlySet<string>>([
  ["https://next-kamakura.niho.life", new Set(["https://next-kamakura.niho.life", "https://kamakura-media.niho.life"])],
  ["https://kamakura.niho.life", new Set(["https://kamakura.niho.life", "https://kamakura-media.niho.life"])],
  ["https://experience.niho.life", new Set(["https://experience.niho.life"])]
]);
const COMMON_PAGE_ID = KAMAKURA_COMMON_PAGE_ID;
const MAX_PENDING_INVITATIONS = 100;
const MAX_DIRECTORY_PROJECTS = 100;
const MAX_PROJECT_MEMBERS = 500;
const MAX_DIRECTORY_MEMBER_ROWS = MAX_DIRECTORY_PROJECTS * MAX_PROJECT_MEMBERS;
const JWKS_CACHE_MILLISECONDS = 5 * 60 * 1000;
let jwksCache: { readonly url: string; readonly expiresAt: number; readonly keys: readonly SigningJwk[] } | undefined;
let lastForcedJwksRefreshAt = 0;

class AuthenticationError extends Error {}
class ConfigurationError extends Error {}
class SigningKeysUnavailableError extends Error {}
class InvalidInputError extends Error {}
class BridgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeUnavailableError";
  }
}

type KamakuraBridgeOperation =
  | "catalog"
  | "page_read"
  | "draft_save"
  | "release_plan"
  | "release"
  | "english_publication_retry"
  | "asset_list"
  | "asset_upload_intent"
  | "asset_update"
  | "asset_usages"
  | "asset_resolve"
  | "embed_import"
  | "embed_status"
  | "cms_schema"
  | "cms_list"
  | "cms_read"
  | "cms_english_publication_read"
  | "cms_english_publication_retry"
  | "cms_create"
  | "cms_draft_save"
  | "cms_publish"
  | "cms_discard_draft"
  | "cms_unpublish"
  | "cms_duplicate"
  | "cms_remove"
  | "cms_schedule"
  | "cms_cancel_schedule"
  | "cms_retry_schedule"
  | "cms_reorder"
  | "cms_bulk"
  | "cms_upload_intent"
  | "localization_overview"
  | "localization_list"
  | "localization_item"
  | "localization_command"
  | "localization_translate"
  | "localization_job"
  | "localization_catalog"
  | "localization_preview"
  | "localization_release"
  | "localization_release_prepare"
  | "localization_release_apply"
  | "localization_settings"
  | "localization_upload_intent"
  | "localization_editor_page"
  | "localization_editor_snapshot"
  | "localization_editor_site"
  | "localization_editor_save"
  | "localization_editor_command"
  | "site_overview";
type KamakuraBridgeFailureCategory =
  | "bridge_secret_missing_or_invalid"
  | "bridge_signing_failed"
  | "service_binding_failed"
  | "service_binding_timeout"
  | "upstream_auth_rejected"
  | "upstream_unexpected_4xx"
  | "catalog_endpoint_missing"
  | "cms_endpoint_missing"
  | "localization_endpoint_missing"
  | "overview_endpoint_missing"
  | "upstream_rate_limited"
  | "upstream_server_error"
  | "upstream_redirect_rejected"
  | "upstream_invalid_response"
  | "upstream_contract_invalid"
  | "bridge_processing_failed";

class KamakuraBridgeFailureError extends Error {
  readonly code: typeof KAMAKURA_CATALOG_CONTRACT_ERROR_CODE | "service_unavailable";
  readonly httpStatus: 502 | 503;

  constructor(
    readonly supportId: string,
    readonly operation: KamakuraBridgeOperation,
    readonly category: KamakuraBridgeFailureCategory,
    readonly upstreamStatus?: number
  ) {
    super("Kamakura editor bridge request failed");
    this.name = "KamakuraBridgeFailureError";
    this.code = category === "upstream_contract_invalid" ? KAMAKURA_CATALOG_CONTRACT_ERROR_CODE : "service_unavailable";
    this.httpStatus = category === "upstream_contract_invalid" ? KAMAKURA_CATALOG_CONTRACT_ERROR_STATUS : 503;
  }
}

function securityHeaders(contentType: string): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: securityHeaders("application/json; charset=utf-8") });
}

function htmlError(message: string, status: number): Response {
  const body = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>NIHO Studio</title><body><main><h1>NIHO Studio</h1><p>${message}</p></main></body></html>`;
  const headers = securityHeaders("text/html; charset=utf-8");
  headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  return new Response(body, { status, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new InvalidInputError("unexpected input fields");
}

function decodeBase64Url(value: string, maximumLength: number): Uint8Array {
  if (!value || value.length > maximumLength || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new AuthenticationError("invalid token encoding");
  const padding = (4 - value.length % 4) % 4;
  let decoded: string;
  try { decoded = atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat(padding)); }
  catch { throw new AuthenticationError("invalid token encoding"); }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function encodeBase64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function bridgeSecret(encoded: string | undefined): Uint8Array {
  if (typeof encoded !== "string" || !encoded || encoded.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new ConfigurationError("invalid Studio bridge secret");
  let decoded: Uint8Array;
  try { decoded = decodeBase64Url(encoded, 1024); }
  catch { throw new ConfigurationError("invalid Studio bridge secret"); }
  if (decoded.byteLength < 32 || encodeBase64Url(decoded) !== encoded) throw new ConfigurationError("invalid Studio bridge secret");
  return decoded;
}

function hexadecimal(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeJwtObject<T>(segment: string, maximumLength: number): T {
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(segment, maximumLength));
    value = JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    throw new AuthenticationError("invalid token JSON");
  }
  if (!isRecord(value)) throw new AuthenticationError("invalid token object");
  return value as T;
}

function accessConfiguration(env: Env): { readonly issuer: string; readonly audience: string; readonly jwksUrl: string } {
  let issuerUrl: URL;
  try { issuerUrl = new URL(env.ACCESS_ISSUER); }
  catch { throw new ConfigurationError("invalid Access issuer"); }
  if (issuerUrl.protocol !== "https:" || issuerUrl.username || issuerUrl.password || issuerUrl.pathname !== "/" || issuerUrl.search || issuerUrl.hash || issuerUrl.origin !== env.ACCESS_ISSUER) {
    throw new ConfigurationError("Access issuer must be an exact HTTPS origin");
  }
  if (!env.ACCESS_AUDIENCE || env.ACCESS_AUDIENCE.length > 256 || /\s/u.test(env.ACCESS_AUDIENCE)) throw new ConfigurationError("invalid Access audience");
  return { issuer: env.ACCESS_ISSUER, audience: env.ACCESS_AUDIENCE, jwksUrl: `${env.ACCESS_ISSUER}/cdn-cgi/access/certs` };
}

async function loadJwks(url: string, force = false): Promise<readonly SigningJwk[]> {
  const now = Date.now();
  if (!force && jwksCache?.url === url && jwksCache.expiresAt > now) return jwksCache.keys;
  const response = await fetch(url, { redirect: "manual", headers: { Accept: "application/json" } });
  if (!response.ok) throw new SigningKeysUnavailableError("unable to load signing keys");
  const text = await response.text();
  if (text.length > 256 * 1024) throw new SigningKeysUnavailableError("signing keys response too large");
  let document: unknown;
  try { document = JSON.parse(text) as unknown; }
  catch { throw new SigningKeysUnavailableError("invalid signing keys"); }
  if (!isRecord(document) || !Array.isArray((document as JwksDocument).keys)) throw new SigningKeysUnavailableError("invalid signing keys");
  const keys = (document as { keys: readonly unknown[] }).keys.filter((key): key is SigningJwk => isRecord(key) && key.kty === "RSA");
  if (keys.length === 0 || keys.length > 20) throw new SigningKeysUnavailableError("invalid signing keys");
  jwksCache = { url, expiresAt: now + JWKS_CACHE_MILLISECONDS, keys };
  return keys;
}

function selectSigningKey(keys: readonly SigningJwk[], kid: string): SigningJwk | undefined {
  return keys.find((key) => key.kid === kid && key.kty === "RSA" && (key.alg === undefined || key.alg === "RS256") && (key.use === undefined || key.use === "sig") && (key.key_ops === undefined || Array.isArray(key.key_ops) && key.key_ops.includes("verify")));
}

async function verifySignature(signingInput: string, signature: Uint8Array, key: SigningJwk): Promise<boolean> {
  try {
    const cryptoKey = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature.slice().buffer, new TextEncoder().encode(signingInput));
  } catch { return false; }
}

function finiteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function validSubject(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value && !/\p{Cc}/u.test(value);
}

function normalizeEmail(value: unknown, ErrorType: typeof AuthenticationError | typeof InvalidInputError): string {
  if (typeof value !== "string" || value.length < 3 || value.length > 254 || value.trim() !== value || !/^[\x21-\x7e]+$/u.test(value)) throw new ErrorType("invalid email");
  const email = value.toLowerCase();
  const parts = email.split("@");
  if (parts.length !== 2) throw new ErrorType("invalid email");
  const [local, domain] = parts as [string, string];
  if (!local || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..") || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(local)) throw new ErrorType("invalid email");
  if (!domain || domain.length > 253 || domain.startsWith(".") || domain.endsWith(".")) throw new ErrorType("invalid email");
  const labels = domain.split(".");
  if (labels.some((label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-") || !/^[a-z0-9-]+$/u.test(label))) throw new ErrorType("invalid email");
  return email;
}

async function authenticate(request: Request, env: Env): Promise<AccessIdentity> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || token.length > 64 * 1024) throw new AuthenticationError("missing Access assertion");
  const segments = token.split(".");
  if (segments.length !== 3) throw new AuthenticationError("invalid Access assertion");
  const [encodedHeader, encodedClaims, encodedSignature] = segments as [string, string, string];
  const header = decodeJwtObject<JwtHeader>(encodedHeader, 4096);
  const claims = decodeJwtObject<JwtClaims>(encodedClaims, 32 * 1024);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid || header.kid.length > 256 || (header.typ !== undefined && header.typ !== "JWT")) {
    throw new AuthenticationError("unsupported Access assertion");
  }
  const configuration = accessConfiguration(env);
  let keys = await loadJwks(configuration.jwksUrl);
  let key = selectSigningKey(keys, header.kid);
  if (!key && Date.now() - lastForcedJwksRefreshAt >= 30_000) {
    lastForcedJwksRefreshAt = Date.now();
    keys = await loadJwks(configuration.jwksUrl, true);
    key = selectSigningKey(keys, header.kid);
  }
  if (!key || !await verifySignature(`${encodedHeader}.${encodedClaims}`, decodeBase64Url(encodedSignature, 8192), key)) throw new AuthenticationError("invalid Access signature");

  const now = Math.floor(Date.now() / 1000);
  const audiences = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) && claims.aud.every((entry) => typeof entry === "string") ? claims.aud : [];
  if (claims.iss !== configuration.issuer || !audiences.includes(configuration.audience) || claims.type !== "app") throw new AuthenticationError("invalid Access claims");
  if (!finiteInteger(claims.exp) || !finiteInteger(claims.iat) || claims.exp <= now || claims.iat > now + 60 || claims.exp <= claims.iat) throw new AuthenticationError("expired Access assertion");
  if (claims.nbf !== undefined && (!finiteInteger(claims.nbf) || claims.nbf > now + 60)) throw new AuthenticationError("inactive Access assertion");
  if (!validSubject(claims.sub)) throw new AuthenticationError("invalid Access subject");
  return { subject: claims.sub, email: normalizeEmail(claims.email, AuthenticationError) };
}

function validIdentifier(value: string): boolean { return /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(value); }
function validName(value: string): boolean { return value.length > 0 && value.length <= 120 && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value); }
function validRole(value: unknown): value is Role { return value === "owner" || value === "editor"; }
function validInvitationId(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value); }
function validInvitationToken(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value); }

function domainsFor(origin: string | null): readonly string[] {
  if (origin === null) return [];
  let url: URL;
  try { url = new URL(origin); } catch { throw new Error("invalid stored site origin"); }
  if (url.protocol !== "https:" || url.username || url.password || url.origin !== origin || url.pathname !== "/" || url.search || url.hash) throw new Error("invalid stored site origin");
  return [origin];
}

function projectFromRow(row: ProjectRow, subject: string) {
  if (!validIdentifier(row.project_id) || !validIdentifier(row.site_id) || !validName(row.project_name) || !validName(row.site_name) || !validName(row.display_name)) throw new Error("invalid stored project");
  return {
    id: row.project_id,
    name: row.project_name,
    site: { id: row.site_id, name: row.site_name, domains: domainsFor(row.public_origin) },
    members: [{ userId: subject, displayName: row.display_name }]
  };
}

function decodeOgAttribute(value: string): string {
  return value.replace(/&(?:amp|quot|apos|#39|#x27);/giu, (entity) => {
    switch (entity.toLowerCase()) {
      case "&amp;": return "&";
      case "&quot;": return '"';
      default: return "'";
    }
  });
}

function ogImageFromHtml(html: string): string | null {
  for (const match of html.matchAll(/<meta\b[^>]*>/giu)) {
    const attributes = new Map<string, string>();
    for (const attribute of match[0].matchAll(/\b(property|content)\s*=\s*(["'])(.*?)\2/gisu)) {
      attributes.set(attribute[1]!.toLowerCase(), decodeOgAttribute(attribute[3]!.trim()));
    }
    if (attributes.get("property")?.toLowerCase() === "og:image") return attributes.get("content") ?? null;
  }
  return null;
}

async function readBoundedHtml(response: Response): Promise<string> {
  if (response.status !== 200 || response.redirected) throw new Error("directory preview response rejected");
  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "text/html") throw new Error("directory preview HTML required");
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > DIRECTORY_OG_MAX_RESPONSE_BYTES)) throw new Error("directory preview response too large");
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > DIRECTORY_OG_MAX_RESPONSE_BYTES) {
        await reader.cancel("directory preview response too large");
        throw new Error("directory preview response too large");
      }
      chunks.push(chunk.value);
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

type DirectoryPublicPage = { readonly published: boolean; readonly thumbnailUrl: string | null };
async function directoryPublicPage(origin: string): Promise<DirectoryPublicPage> {
  const allowedImageOrigins = DIRECTORY_OG_SOURCES.get(origin);
  if (!allowedImageOrigins) return { published: false, thumbnailUrl: null };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DIRECTORY_OG_TIMEOUT_MILLISECONDS);
  try {
    const response = await fetch(`${origin}/`, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
      headers: { Accept: "text/html" }
    });
    const rawImage = ogImageFromHtml(await readBoundedHtml(response));
    if (rawImage === null || rawImage.length > 2048) return { published: true, thumbnailUrl: null };
    let image: URL;
    try { image = new URL(rawImage); } catch { return { published: true, thumbnailUrl: null }; }
    if (image.protocol !== "https:" || image.username || image.password || image.hash || !allowedImageOrigins.has(image.origin)) return { published: true, thumbnailUrl: null };
    return { published: true, thumbnailUrl: image.href };
  } catch { return { published: false, thumbnailUrl: null }; }
  finally { clearTimeout(timeout); }
}

type DirectoryMembers = Map<string, { readonly status: "ready"; readonly data: { readonly displayName: string; readonly role: Role }[] }>;

/** 認可済みの最大100 Projectに属する参加者だけを1 queryで読む。subject・emailは選択も返却もしない。 */
async function directoryMembers(env: Env, subject: string): Promise<DirectoryMembers | null> {
  try {
    const result = await env.DB.prepare(`
      WITH visible_projects AS (
        SELECT p.id, p.name
          FROM project_members AS actor
          JOIN projects AS p ON p.id = actor.project_id
          JOIN sites AS s ON s.project_id = p.id
         WHERE actor.access_subject = ?1
         ORDER BY p.name COLLATE NOCASE, p.id
         LIMIT ${MAX_DIRECTORY_PROJECTS}
      )
      SELECT members.project_id, members.display_name, members.role
        FROM visible_projects
        JOIN project_members AS members ON members.project_id = visible_projects.id
       ORDER BY visible_projects.name COLLATE NOCASE, visible_projects.id,
                CASE members.role WHEN 'owner' THEN 0 ELSE 1 END,
                members.display_name COLLATE NOCASE, members.access_subject
       LIMIT ${MAX_DIRECTORY_MEMBER_ROWS}
    `).bind(subject).all<DirectoryMemberRow>();
    if (!result.success) throw new Error("directory members query failed");
    const members: DirectoryMembers = new Map();
    for (const row of result.results ?? []) {
      if (!validIdentifier(row.project_id) || !validName(row.display_name) || !validRole(row.role)) throw new Error("invalid stored directory member");
      const current = members.get(row.project_id);
      if (current === undefined) members.set(row.project_id, { status: "ready", data: [{ displayName: row.display_name, role: row.role }] });
      else {
        if (current.data.length >= MAX_PROJECT_MEMBERS) throw new Error("too many stored directory members");
        current.data.push({ displayName: row.display_name, role: row.role });
      }
    }
    return members;
  } catch (error) {
    console.warn("NIHO Studio directory members unavailable", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

async function directory(env: Env, identity: AccessIdentity): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT p.id AS project_id, p.name AS project_name,
           s.id AS site_id, s.name AS site_name, s.public_origin,
           m.display_name
      FROM project_members AS m
      JOIN projects AS p ON p.id = m.project_id
      JOIN sites AS s ON s.project_id = p.id
     WHERE m.access_subject = ?1
     ORDER BY p.name COLLATE NOCASE, p.id
     LIMIT ${MAX_DIRECTORY_PROJECTS}
  `).bind(identity.subject).all<ProjectRow>();
  if (!result.success) throw new Error("directory query failed");
  const rows = result.results ?? [];
  const publicPages = new Map<string, Promise<DirectoryPublicPage>>();
  for (const row of rows) {
    if (row.public_origin !== null && DIRECTORY_OG_SOURCES.has(row.public_origin) && !publicPages.has(row.public_origin)) {
      publicPages.set(row.public_origin, directoryPublicPage(row.public_origin));
    }
  }
  const membersPromise = directoryMembers(env, identity.subject);
  const resolvedPublicPages = new Map(await Promise.all([...publicPages].map(async ([origin, page]) => [origin, await page] as const)));
  const members = await membersPromise;
  const entries = rows.map((row) => {
    const project = projectFromRow(row, identity.subject);
    const publicPage = row.public_origin === null ? null : resolvedPublicPages.get(row.public_origin) ?? null;
    const thumbnailUrl = publicPage?.thumbnailUrl ?? null;
    return {
      project,
      summary: {
        projectId: project.id,
        siteId: project.site.id,
        publicationStatus: publicPage?.published ? "published" : "unknown",
        publishedUrl: publicPage?.published ? row.public_origin : null,
        thumbnail: thumbnailUrl === null ? null : { url: thumbnailUrl, alt: `${project.site.name}のプレビュー` },
        updatedAt: null,
        lastAccessedAt: null,
        members: members?.get(project.id) ?? { status: "unavailable" }
      }
    };
  });
  return json({ status: "ready", entries });
}

async function dashboard(env: Env, identity: AccessIdentity, projectId: string, siteId: string): Promise<Response> {
  const row = await env.DB.prepare(`
    SELECT p.id AS project_id, p.name AS project_name,
           s.id AS site_id, s.name AS site_name, s.public_origin,
           m.display_name
      FROM project_members AS m
      JOIN projects AS p ON p.id = m.project_id
      JOIN sites AS s ON s.project_id = p.id
     WHERE m.access_subject = ?1 AND p.id = ?2 AND s.id = ?3
     LIMIT 1
  `).bind(identity.subject, projectId, siteId).first<ProjectRow>();
  if (row === null) return json({ status: "forbidden", projectId, siteId });
  const project = projectFromRow(row, identity.subject);
  // 公開情報は鎌倉だけサイト側から読む。ほかのサイトと解析は値を合成しない（unavailable / disconnected のまま）。
  const [overview, members] = await Promise.all([
    projectId === KAMAKURA_EDITOR_PROJECT_ID && siteId === KAMAKURA_EDITOR_SITE_ID
      ? kamakuraOverview(env, identity, project.site.domains)
      : Promise.resolve<DashboardOverview>({ status: "unavailable" }),
    dashboardMembers(env, projectId)
  ]);
  return json({
    status: "ready",
    projectId,
    siteId,
    fetchedAt: new Date().toISOString(),
    overview,
    analytics: { status: "disconnected" },
    members
  });
}

type DashboardMembers = { readonly status: "unavailable" } | { readonly status: "ready"; readonly data: readonly { readonly displayName: string; readonly role: Role }[] };

/**
 * Dashboard のメンバー表示（#66）: 参加者全員の表示名と役割。参加していることは dashboard() が先に確かめているので、
 * owner でも editor でも読める。Access subject・メール・作成日時は出さない（招待・権限変更は membership API のまま owner だけ）。
 * 読めないときは members だけ unavailable にして Dashboard 全体は返す。
 */
async function dashboardMembers(env: Env, projectId: string): Promise<DashboardMembers> {
  try {
    const result = await env.DB.prepare(`
      SELECT m.display_name, m.role
        FROM project_members AS m
       WHERE m.project_id = ?1
       ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.display_name COLLATE NOCASE, m.access_subject
       LIMIT ?2
    `).bind(projectId, MAX_PROJECT_MEMBERS).all<Pick<MemberRow, "display_name" | "role">>();
    if (!result.success) throw new Error("members query failed");
    const data = (result.results ?? []).map((member) => {
      if (!validName(member.display_name) || !validRole(member.role)) throw new Error("invalid stored member");
      return { displayName: member.display_name, role: member.role };
    });
    return { status: "ready", data };
  } catch (error) {
    console.warn("NIHO Studio dashboard members unavailable", error instanceof Error ? error.name : "UnknownError");
    return { status: "unavailable" };
  }
}

type DashboardOverviewData = {
  readonly publicationStatus: "published" | "unpublished" | "unknown";
  readonly publishedUrl: string | null;
  readonly lastPublishedAt: string | null;
  readonly publishedPageCount: number | null;
  readonly assetBytes: number | null;
  readonly recentChanges: readonly { readonly id: string; readonly label: string; readonly changedAt: string }[];
};
type DashboardOverview = { readonly status: "unavailable" } | { readonly status: "ready"; readonly data: DashboardOverviewData };

class KamakuraOverviewContractError extends Error {}

function overviewContract(condition: boolean): asserts condition {
  if (!condition) throw new KamakuraOverviewContractError("invalid Kamakura overview");
}

/** ISO 8601（timezone 付き・暦として正しい）だけを受け、UTC の toISOString に揃える。 */
function overviewTimestamp(value: unknown): string {
  overviewContract(typeof value === "string" && value.length <= 40);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  overviewContract(match !== null);
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match.map(Number);
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month! - 1] ?? 0;
  overviewContract(day! >= 1 && day! <= days && hour! <= 23 && minute! <= 59 && second! <= 59 && (match[7] === undefined || (offsetHour! <= 23 && offsetMinute! <= 59)));
  const time = Date.parse(value);
  overviewContract(Number.isFinite(time));
  return new Date(time).toISOString();
}

function overviewCount(value: unknown): number | null {
  if (value === null) return null;
  overviewContract(typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  return value;
}

/**
 * kamakura-site の公開情報を検査し、ProjectOverview の既知の key だけで組み立て直す（上流の未知の key は捨てる）。
 * 形の誤りは KamakuraOverviewContractError。公開 URL がこのサイトの D1 の公開 origin と違う（切替の直後など）ときは URL だけ出さない。
 */
function kamakuraOverviewData(value: unknown, domains: readonly string[]): DashboardOverviewData {
  overviewContract(isRecord(value));
  const status = value.publicationStatus;
  overviewContract(status === "published" || status === "unpublished" || status === "unknown");
  const rawUrl = value.publishedUrl;
  let publishedUrl: string | null = null;
  if (rawUrl !== null) {
    overviewContract(status === "published" && typeof rawUrl === "string" && rawUrl.length <= 2048);
    let url: URL;
    try { url = new URL(rawUrl); } catch { throw new KamakuraOverviewContractError("invalid Kamakura overview URL"); }
    const origin = url.origin;
    overviewContract(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/" && (rawUrl === origin || rawUrl === `${origin}/`));
    publishedUrl = domains.find((domain) => domain === origin) ?? null;
  }
  const changes = value.recentChanges;
  overviewContract(Array.isArray(changes) && changes.length <= 20);
  const recentChanges = changes.map((change: unknown) => {
    overviewContract(isRecord(change));
    const { id, label } = change;
    overviewContract(typeof id === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(id));
    overviewContract(typeof label === "string" && label.trim().length > 0 && label.length <= 240 && !/\p{Cc}/u.test(label));
    return { id, label, changedAt: overviewTimestamp(change.changedAt) };
  });
  overviewContract(new Set(recentChanges.map((change) => change.id)).size === recentChanges.length);
  return {
    publicationStatus: status,
    publishedUrl,
    lastPublishedAt: value.lastPublishedAt === null ? null : overviewTimestamp(value.lastPublishedAt),
    publishedPageCount: overviewCount(value.publishedPageCount),
    assetBytes: overviewCount(value.assetBytes),
    recentChanges
  };
}

/**
 * 鎌倉の公開情報を署名つき GET で読む（editor・CMS と同じ署名・redirect 拒否・JSON 上限）。
 * 上流の失敗・形の誤り・timeout はすべて unavailable にして Dashboard 全体は 200 のまま返す。ログは support ID・操作・分類・status だけ。
 */
async function kamakuraOverview(env: Env, identity: AccessIdentity, domains: readonly string[]): Promise<DashboardOverview> {
  const supportId = crypto.randomUUID();
  const operation: KamakuraBridgeOperation = "site_overview";
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(kamakuraBridgeFailure(supportId, operation, "service_binding_timeout")); }, KAMAKURA_OVERVIEW_TIMEOUT_MILLISECONDS);
  });
  const read = async (): Promise<DashboardOverviewData> => {
    const headers = await kamakuraSignedHeaders(env, identity, "GET", KAMAKURA_OVERVIEW_UPSTREAM_PATH, new Uint8Array(), supportId, operation);
    const upstream = new Request(`${KAMAKURA_EDITOR_UPSTREAM_ORIGIN}${KAMAKURA_OVERVIEW_UPSTREAM_PATH}`, { method: "GET", cache: "no-store", redirect: "manual", signal: controller.signal, headers });
    let response: Response;
    try { response = await env.KAMAKURA_SITE.fetch(upstream); }
    catch { throw kamakuraBridgeFailure(supportId, operation, controller.signal.aborted ? "service_binding_timeout" : "service_binding_failed"); }
    const status = response.status;
    if (status !== 200) {
      try { await response.body?.cancel(); } catch { /* 本文は使わない */ }
      if (status >= 300 && status < 400) throw kamakuraBridgeFailure(supportId, operation, "upstream_redirect_rejected", status);
      if (status === 401 || status === 403) throw kamakuraBridgeFailure(supportId, operation, "upstream_auth_rejected", status);
      if (status === 404) throw kamakuraBridgeFailure(supportId, operation, "overview_endpoint_missing", status);
      if (status === 429) throw kamakuraBridgeFailure(supportId, operation, "upstream_rate_limited", status);
      if (status >= 500) throw kamakuraBridgeFailure(supportId, operation, "upstream_server_error", status);
      throw kamakuraBridgeFailure(supportId, operation, status >= 400 ? "upstream_unexpected_4xx" : "upstream_contract_invalid", status);
    }
    let value: unknown;
    try { value = await readBoundedResponse(response, KAMAKURA_OVERVIEW_MAX_RESPONSE_BYTES); }
    catch { throw kamakuraBridgeFailure(supportId, operation, controller.signal.aborted ? "service_binding_timeout" : "upstream_invalid_response", status); }
    try { return kamakuraOverviewData(value, domains); }
    catch (error) { throw kamakuraBridgeFailure(supportId, operation, error instanceof KamakuraOverviewContractError ? "upstream_contract_invalid" : "bridge_processing_failed", status); }
  };
  try {
    return { status: "ready", data: await Promise.race([read(), expired]) };
  } catch (error) {
    logKamakuraBridgeFailure(error instanceof KamakuraBridgeFailureError ? error : kamakuraBridgeFailure(supportId, operation, "bridge_processing_failed"));
    return { status: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

function ownerContextStatement(env: Env, identity: AccessIdentity, projectId: string, siteId: string): D1Statement {
  return env.DB.prepare(`
    SELECT p.name AS project_name, s.name AS site_name
      FROM project_members AS actor
      JOIN projects AS p ON p.id = actor.project_id
      JOIN sites AS s ON s.project_id = p.id
     WHERE actor.access_subject = ?1 AND actor.role = 'owner'
       AND p.id = ?2 AND s.id = ?3
     LIMIT 1
  `).bind(identity.subject, projectId, siteId);
}

function firstRow<T>(result: D1Result<unknown> | undefined): T | undefined {
  return result?.results?.[0] as T | undefined;
}

function changed(result: D1Result<unknown> | undefined): boolean {
  return result?.success === true && result.meta?.changes === 1;
}

function unixTimestamp(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid stored timestamp");
  return new Date(value * 1000).toISOString();
}

async function membershipAdministration(env: Env, identity: AccessIdentity, projectId: string, siteId: string): Promise<Response> {
  const results = await env.DB.batch<unknown>([
    ownerContextStatement(env, identity, projectId, siteId),
    env.DB.prepare(`
      SELECT m.access_subject, m.email, m.role, m.display_name, m.created_at
        FROM project_members AS m
       WHERE m.project_id = ?2
         AND EXISTS (
           SELECT 1 FROM project_members AS actor
           JOIN sites AS s ON s.project_id = actor.project_id
            WHERE actor.access_subject = ?1 AND actor.role = 'owner'
              AND actor.project_id = ?2 AND s.id = ?3
         )
       ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.display_name COLLATE NOCASE, m.access_subject
       LIMIT 500
    `).bind(identity.subject, projectId, siteId),
    env.DB.prepare(`
      SELECT i.id, i.email, i.role, i.created_at, i.expires_at,
             CASE
               WHEN i.used_at IS NOT NULL THEN 'accepted'
               WHEN i.revoked_at IS NOT NULL THEN 'revoked'
               WHEN i.expires_at <= unixepoch() THEN 'expired'
               ELSE 'pending'
             END AS status
        FROM project_invitations AS i
       WHERE i.project_id = ?2
         AND EXISTS (
           SELECT 1 FROM project_members AS actor
           JOIN sites AS s ON s.project_id = actor.project_id
            WHERE actor.access_subject = ?1 AND actor.role = 'owner'
              AND actor.project_id = ?2 AND s.id = ?3
         )
       ORDER BY i.created_at DESC, i.id DESC
       LIMIT 100
    `).bind(identity.subject, projectId, siteId)
  ]);
  const context = firstRow<AdminContextRow>(results[0]);
  if (!context) return json({ error: "forbidden" }, 403);
  if (!validName(context.project_name) || !validName(context.site_name)) throw new Error("invalid stored project");
  const members = ((results[1]?.results ?? []) as readonly MemberRow[]).map((member) => ({
    subject: member.access_subject,
    email: member.email,
    role: member.role,
    displayName: member.display_name,
    createdAt: member.created_at,
    isCurrent: member.access_subject === identity.subject
  }));
  const invitations = ((results[2]?.results ?? []) as readonly InvitationRow[]).map((invitation) => ({
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    createdAt: unixTimestamp(invitation.created_at),
    expiresAt: unixTimestamp(invitation.expires_at),
    status: invitation.status
  }));
  return json({ status: "ready", projectName: context.project_name, siteName: context.site_name, members, invitations });
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

async function tokenHash(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function auditActionForInvite(prefix: "invitation.created" | "invitation.accepted", role: Role): string {
  return `${prefix}.${role}`;
}

async function createInvitation(request: Request, env: Env, identity: AccessIdentity, projectId: string, siteId: string, body: Record<string, unknown>): Promise<Response> {
  exactKeys(body, ["email", "role", "expiresInDays"]);
  const email = normalizeEmail(body.email, InvalidInputError);
  if (!validRole(body.role)) throw new InvalidInputError("invalid role");
  if (!Number.isSafeInteger(body.expiresInDays) || (body.expiresInDays as number) < 1 || (body.expiresInDays as number) > 7) throw new InvalidInputError("invalid expiry");
  const role = body.role;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + (body.expiresInDays as number) * 86_400;
  const token = randomToken();
  const hash = await tokenHash(token);
  const invitationId = crypto.randomUUID();
  const results = await env.DB.batch<unknown>([
    ownerContextStatement(env, identity, projectId, siteId),
    env.DB.prepare(`
      INSERT INTO project_invitations
        (id, project_id, email, role, token_hash, invited_by_subject, created_at, expires_at)
      SELECT ?4, ?2, ?5, ?6, ?7, ?1, ?8, ?9
       WHERE EXISTS (
         SELECT 1 FROM project_members AS actor
         JOIN sites AS s ON s.project_id = actor.project_id
          WHERE actor.access_subject = ?1 AND actor.role = 'owner'
            AND actor.project_id = ?2 AND s.id = ?3
       )
         AND (SELECT count(*) FROM project_invitations
               WHERE project_id = ?2 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > unixepoch()) < ?10
         AND NOT EXISTS (
           SELECT 1 FROM project_members
            WHERE project_id = ?2 AND email = ?5
         )
         AND NOT EXISTS (
           SELECT 1 FROM project_invitations
            WHERE project_id = ?2 AND email = ?5
              AND used_at IS NULL AND revoked_at IS NULL AND expires_at > unixepoch()
         )
    `).bind(identity.subject, projectId, siteId, invitationId, email, role, hash, now, expiresAt, MAX_PENDING_INVITATIONS),
    env.DB.prepare(`
      INSERT INTO studio_audit_records (project_id, actor_subject, action, target)
      SELECT ?2, ?1, ?3, ?4 WHERE changes() = 1
    `).bind(identity.subject, projectId, auditActionForInvite("invitation.created", role), email)
  ]);
  if (!firstRow<AdminContextRow>(results[0])) return json({ error: "forbidden" }, 403);
  if (!changed(results[1])) return json({ error: "operation_rejected" }, 409);
  const invitationUrl = new URL(`/projects/${encodeURIComponent(projectId)}/sites/${encodeURIComponent(siteId)}/invite`, request.url);
  invitationUrl.searchParams.set("token", token);
  return json({
    status: "created",
    invitation: { id: invitationId, email, role, expiresAt: unixTimestamp(expiresAt) },
    invitationUrl: invitationUrl.href
  }, 201);
}

async function invitationPreview(env: Env, identity: AccessIdentity, projectId: string, siteId: string, body: Record<string, unknown>): Promise<Response> {
  exactKeys(body, ["token"]);
  if (!validInvitationToken(body.token)) throw new InvalidInputError("invalid invitation token");
  const hash = await tokenHash(body.token);
  const row = await env.DB.prepare(`
    SELECT p.name AS project_name, s.name AS site_name, i.role, i.expires_at
      FROM project_invitations AS i
      JOIN projects AS p ON p.id = i.project_id
      JOIN sites AS s ON s.project_id = p.id
     WHERE i.token_hash = ?1 AND i.email = ?2
       AND i.project_id = ?3 AND s.id = ?4
       AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > unixepoch()
     LIMIT 1
  `).bind(hash, identity.email, projectId, siteId).first<InvitationPreviewRow>();
  if (!row) return json({ error: "invitation_unavailable" }, 404);
  if (!validName(row.project_name) || !validName(row.site_name) || !validRole(row.role)) throw new Error("invalid stored invitation");
  return json({
    status: "ready",
    invitation: { projectName: row.project_name, siteName: row.site_name, role: row.role, expiresAt: unixTimestamp(row.expires_at) }
  });
}

async function acceptInvitation(env: Env, identity: AccessIdentity, projectId: string, siteId: string, body: Record<string, unknown>): Promise<Response> {
  exactKeys(body, ["token"]);
  if (!validInvitationToken(body.token)) throw new InvalidInputError("invalid invitation token");
  const hash = await tokenHash(body.token);
  const results = await env.DB.batch<unknown>([
    env.DB.prepare(`
      INSERT INTO project_members (project_id, access_subject, role, display_name, email)
      SELECT i.project_id, ?1, i.role, ?2, ?2
        FROM project_invitations AS i
        JOIN sites AS s ON s.project_id = i.project_id
       WHERE i.token_hash = ?3 AND i.email = ?2
         AND i.project_id = ?4 AND s.id = ?5
         AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > unixepoch()
         AND (SELECT count(*) FROM project_members WHERE project_id = i.project_id) < ?6
      ON CONFLICT DO NOTHING
    `).bind(identity.subject, identity.email, hash, projectId, siteId, MAX_PROJECT_MEMBERS),
    env.DB.prepare(`
      UPDATE project_invitations
         SET used_at = unixepoch(), accepted_subject = ?1
       WHERE token_hash = ?2 AND email = ?3 AND project_id = ?4
         AND used_at IS NULL AND revoked_at IS NULL AND expires_at > unixepoch()
         AND changes() = 1
    `).bind(identity.subject, hash, identity.email, projectId),
    env.DB.prepare(`
      INSERT INTO studio_audit_records (project_id, actor_subject, action, target)
      SELECT i.project_id, ?1,
             CASE i.role WHEN 'owner' THEN 'invitation.accepted.owner' ELSE 'invitation.accepted.editor' END,
             i.id
        FROM project_invitations AS i
       WHERE i.token_hash = ?2 AND i.accepted_subject = ?1 AND changes() = 1
    `).bind(identity.subject, hash)
  ]);
  if (!changed(results[0]) || !changed(results[1])) return json({ error: "invitation_unavailable" }, 409);
  return json({ status: "accepted" });
}

async function revokeInvitation(env: Env, identity: AccessIdentity, projectId: string, siteId: string, body: Record<string, unknown>): Promise<Response> {
  exactKeys(body, ["invitationId"]);
  if (!validInvitationId(body.invitationId)) throw new InvalidInputError("invalid invitation id");
  const results = await env.DB.batch<unknown>([
    ownerContextStatement(env, identity, projectId, siteId),
    env.DB.prepare(`
      UPDATE project_invitations
         SET revoked_at = unixepoch(), revoked_by_subject = ?1
       WHERE id = ?4 AND project_id = ?2
         AND used_at IS NULL AND revoked_at IS NULL AND expires_at > unixepoch()
         AND EXISTS (
           SELECT 1 FROM project_members AS actor
           JOIN sites AS s ON s.project_id = actor.project_id
            WHERE actor.access_subject = ?1 AND actor.role = 'owner'
              AND actor.project_id = ?2 AND s.id = ?3
         )
    `).bind(identity.subject, projectId, siteId, body.invitationId),
    env.DB.prepare(`
      INSERT INTO studio_audit_records (project_id, actor_subject, action, target)
      SELECT ?2, ?1, 'invitation.revoked', ?3 WHERE changes() = 1
    `).bind(identity.subject, projectId, body.invitationId)
  ]);
  if (!firstRow<AdminContextRow>(results[0])) return json({ error: "forbidden" }, 403);
  if (!changed(results[1])) return json({ error: "operation_rejected" }, 409);
  return json({ status: "revoked" });
}

async function changeMemberRole(env: Env, identity: AccessIdentity, projectId: string, siteId: string, body: Record<string, unknown>): Promise<Response> {
  exactKeys(body, ["subject", "role"]);
  if (!validSubject(body.subject) || !validRole(body.role)) throw new InvalidInputError("invalid member role input");
  const action = body.role === "owner" ? "member.promoted" : "member.demoted";
  let results: readonly D1Result<unknown>[];
  try {
    results = await env.DB.batch<unknown>([
      ownerContextStatement(env, identity, projectId, siteId),
      env.DB.prepare(`
        UPDATE project_members
           SET role = ?5
         WHERE project_id = ?2 AND access_subject = ?4 AND role <> ?5
           AND EXISTS (
             SELECT 1 FROM project_members AS actor
             JOIN sites AS s ON s.project_id = actor.project_id
              WHERE actor.access_subject = ?1 AND actor.role = 'owner'
                AND actor.project_id = ?2 AND s.id = ?3
           )
      `).bind(identity.subject, projectId, siteId, body.subject, body.role),
      env.DB.prepare(`
        INSERT INTO studio_audit_records (project_id, actor_subject, action, target)
        SELECT ?2, ?1, ?3, ?4 WHERE changes() = 1
      `).bind(identity.subject, projectId, action, body.subject)
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("cannot demote the final owner")) return json({ error: "final_owner_required" }, 409);
    throw error;
  }
  if (!firstRow<AdminContextRow>(results[0])) return json({ error: "forbidden" }, 403);
  if (!changed(results[1])) return json({ error: "operation_rejected" }, 409);
  return json({ status: "changed" });
}

async function removeMember(env: Env, identity: AccessIdentity, projectId: string, siteId: string, body: Record<string, unknown>): Promise<Response> {
  exactKeys(body, ["subject"]);
  if (!validSubject(body.subject)) throw new InvalidInputError("invalid member input");
  let results: readonly D1Result<unknown>[];
  try {
    results = await env.DB.batch<unknown>([
      ownerContextStatement(env, identity, projectId, siteId),
      env.DB.prepare(`
        DELETE FROM project_members
         WHERE project_id = ?2 AND access_subject = ?4
           AND EXISTS (
             SELECT 1 FROM project_members AS actor
             JOIN sites AS s ON s.project_id = actor.project_id
              WHERE actor.access_subject = ?1 AND actor.role = 'owner'
                AND actor.project_id = ?2 AND s.id = ?3
           )
      `).bind(identity.subject, projectId, siteId, body.subject),
      env.DB.prepare(`
        INSERT INTO studio_audit_records (project_id, actor_subject, action, target)
        SELECT ?2, ?1, 'member.removed', ?3 WHERE changes() = 1
      `).bind(identity.subject, projectId, body.subject)
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("cannot remove the final owner")) return json({ error: "final_owner_required" }, 409);
    throw error;
  }
  if (!firstRow<AdminContextRow>(results[0])) return json({ error: "forbidden" }, 403);
  if (!changed(results[1])) return json({ error: "operation_rejected" }, 409);
  return json({ status: "removed" });
}

async function enforceMutationBoundary(request: Request): Promise<Record<string, unknown>> {
  const requestUrl = new URL(request.url);
  if (request.headers.get("Origin") !== requestUrl.origin) throw new AuthenticationError("invalid request origin");
  if (request.headers.get("Sec-Fetch-Site") !== "same-origin") throw new AuthenticationError("invalid request site");
  const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") throw new AuthenticationError("JSON required");
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_MUTATION_BODY_BYTES)) throw new AuthenticationError("request body too large");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_MUTATION_BODY_BYTES) {
        await reader.cancel("request body too large");
        throw new AuthenticationError("request body too large");
      }
      chunks.push(chunk.value);
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown; }
  catch { throw new AuthenticationError("invalid JSON"); }
  if (!isRecord(parsed)) throw new AuthenticationError("invalid JSON input");
  return parsed;
}

type KamakuraAssetOperation = "list" | "upload-intent" | "update" | "usages" | "resolve";
type EditorRoute = { readonly upstreamPath: string; readonly bodyLimit: number; readonly assetOperation?: KamakuraAssetOperation; readonly embedOperation?: "import" | "status"; readonly englishPublicationRetry?: true };

/** kamakura-site の worker/studio-assets.ts と同じ固定表。kamakura-upload だけが Studio からのアップロード先。 */
const KAMAKURA_ASSET_PROVIDERS = new Set(["kamakura-upload", "kamakura-admin-upload", "kamakura-studio", "kamakura-cms", "kamakura-approved-remote"]);
const KAMAKURA_ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const KAMAKURA_UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const KAMAKURA_ASSET_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]);
const MAX_KAMAKURA_ASSET_UPLOAD_BYTES = 50 * 1024 * 1024;

function assetText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maximum && (allowEmpty || !!value.trim()) && !/[\u0000-\u001f\u007f]/u.test(value);
}

function onlyAssetKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const keys = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !keys.has(key))) throw new AuthenticationError("invalid asset request");
}

function exactAssetKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort(), keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) throw new AuthenticationError("invalid asset request");
}

function kamakuraAssetReference(value: unknown, uploadOnly = false): Record<string, string> {
  if (!isRecord(value)) throw new AuthenticationError("invalid asset reference");
  exactAssetKeys(value, ["provider", "id"]);
  if (typeof value.provider !== "string" || !KAMAKURA_ASSET_PROVIDERS.has(value.provider) || (uploadOnly && value.provider !== "kamakura-upload") || typeof value.id !== "string" || !(value.provider === "kamakura-upload" ? KAMAKURA_UPLOAD_ID.test(value.id) : KAMAKURA_ASSET_ID.test(value.id))) throw new AuthenticationError("invalid asset reference");
  return { provider: value.provider, id: value.id };
}

function validateKamakuraAssetBody(body: Uint8Array, operation: KamakuraAssetOperation): Uint8Array {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown; }
  catch { throw new AuthenticationError("invalid asset JSON"); }
  if (!isRecord(parsed) || parsed.siteId !== KAMAKURA_EDITOR_SITE_ID) throw new AuthenticationError("invalid asset site");
  if (operation === "list") {
    onlyAssetKeys(parsed, ["siteId", "search", "kind", "folderId", "limit"], ["cursor", "provider", "recent"]);
    if (!assetText(parsed.search, 200, true) || !["all", "image", "video", "pdf", "other"].includes(String(parsed.kind)) || parsed.folderId !== null || !Number.isSafeInteger(parsed.limit) || (parsed.limit as number) < 1 || (parsed.limit as number) > 60) throw new AuthenticationError("invalid asset list request");
    if (parsed.cursor !== undefined && !assetText(parsed.cursor, 500)) throw new AuthenticationError("invalid asset cursor");
    if (parsed.provider !== undefined && (typeof parsed.provider !== "string" || !KAMAKURA_ASSET_PROVIDERS.has(parsed.provider))) throw new AuthenticationError("invalid asset provider");
    if (parsed.recent !== undefined && typeof parsed.recent !== "boolean") throw new AuthenticationError("invalid asset recent flag");
  } else if (operation === "upload-intent") {
    exactAssetKeys(parsed, ["siteId", "folderId", "name", "mimeType", "bytes", "provider"]);
    if (parsed.folderId !== null || parsed.provider !== "kamakura-upload" || !assetText(parsed.name, 200) || typeof parsed.mimeType !== "string" || !KAMAKURA_ASSET_IMAGE_TYPES.has(parsed.mimeType) || !Number.isSafeInteger(parsed.bytes) || (parsed.bytes as number) < 1 || (parsed.bytes as number) > MAX_KAMAKURA_ASSET_UPLOAD_BYTES) throw new AuthenticationError("invalid asset upload request");
  } else if (operation === "update") {
    exactAssetKeys(parsed, ["siteId", "reference", "expectedVersion", "changes"]);
    const reference = kamakuraAssetReference(parsed.reference, true);
    if (!assetText(parsed.expectedVersion, 200) || !isRecord(parsed.changes)) throw new AuthenticationError("invalid asset update request");
    onlyAssetKeys(parsed.changes, [], ["name", "alt"]);
    if (Object.keys(parsed.changes).length === 0 || parsed.changes.name !== undefined && !assetText(parsed.changes.name, 200) || parsed.changes.alt !== undefined && !assetText(parsed.changes.alt, 1000, true)) throw new AuthenticationError("invalid asset metadata");
    parsed.reference = reference;
  } else if (operation === "usages") {
    exactAssetKeys(parsed, ["siteId", "reference"]);
    parsed.reference = kamakuraAssetReference(parsed.reference);
  } else {
    exactAssetKeys(parsed, ["siteId", "references"]);
    if (!Array.isArray(parsed.references) || parsed.references.length > 5000) throw new AuthenticationError("invalid asset references");
    parsed.references = parsed.references.map((reference) => kamakuraAssetReference(reference));
  }
  return new TextEncoder().encode(JSON.stringify(parsed));
}

function experienceEditorRoute(action: string, method: string, staging = false): EditorRoute | "method_not_allowed" | null {
  const routeAction = staging ? action.replace(/^\/editor-staging(?=\/|$)/u, "/editor") : action;
  const fixed = new Map<string, "GET">([
    ["/editor/sites", "GET"],
    ["/editor/sites/experience/pages", "GET"]
  ]);
  const page = /^\/editor\/sites\/experience\/pages\/(home|experiences|experience-detail|booking|host|chrome)\/en(\/draft|\/release-plan|\/release)?$/u.exec(routeAction);
  if (page) {
    const suffix = page[2] ?? "";
    const expected = suffix === "/draft" ? "PUT" : suffix === "/release-plan" || suffix === "/release" ? "POST" : "GET";
    if (method !== expected) return "method_not_allowed";
    return { upstreamPath: `${EDITOR_UPSTREAM_PREFIX}${routeAction.slice("/editor".length)}`, bodyLimit: suffix === "/draft" ? MAX_EDITOR_SAVE_BODY_BYTES : MAX_MUTATION_BODY_BYTES };
  }
  const expected = fixed.get(routeAction);
  if (!expected) return null;
  if (method !== expected) return "method_not_allowed";
  return { upstreamPath: `${EDITOR_UPSTREAM_PREFIX}${routeAction.slice("/editor".length)}`, bodyLimit: MAX_MUTATION_BODY_BYTES };
}

function kamakuraEditorRoute(action: string, method: string): EditorRoute | "method_not_allowed" | null {
  const embed = /^\/editor\/embeds\/([a-z][a-z0-9-]{0,59})\/(import|status)$/u.exec(action);
  if (embed) {
    if (method !== "POST") return "method_not_allowed";
    if (!COMMON_PAGE_ID.test(embed[1]!)) return null;
    return { upstreamPath: `${KAMAKURA_EDITOR_UPSTREAM_PREFIX}/embeds/${embed[1]}/${embed[2]}`, bodyLimit: MAX_MUTATION_BODY_BYTES, embedOperation: embed[2] as "import" | "status" };
  }
  const asset = /^\/editor\/assets\/(list|upload-intent|update|usages|resolve)$/u.exec(action);
  if (asset) {
    if (method !== "POST") return "method_not_allowed";
    const operation = asset[1] as KamakuraAssetOperation;
    return { upstreamPath: `${KAMAKURA_EDITOR_UPSTREAM_PREFIX}/assets/${operation}`, bodyLimit: operation === "resolve" ? MAX_EDITOR_SAVE_BODY_BYTES : MAX_MUTATION_BODY_BYTES, assetOperation: operation };
  }
  if (action === "/editor/catalog") {
    if (method !== "GET") return "method_not_allowed";
    return { upstreamPath: `${KAMAKURA_EDITOR_UPSTREAM_PREFIX}/catalog`, bodyLimit: MAX_MUTATION_BODY_BYTES };
  }
  const page = /^\/editor\/((?!(?:catalog|create|index)$)[a-z][a-z0-9-]{0,59})(\/draft|\/release-plan|\/release|\/english-publication-retry)?$/u.exec(action);
  if (!page || !COMMON_PAGE_ID.test(page[1]!)) return null;
  const suffix = page[2] ?? "";
  const expected = suffix === "/draft" ? "PUT" : suffix === "/release-plan" || suffix === "/release" || suffix === "/english-publication-retry" ? "POST" : "GET";
  if (method !== expected) return "method_not_allowed";
  return { upstreamPath: `${KAMAKURA_EDITOR_UPSTREAM_PREFIX}/${page[1]}${suffix}`, bodyLimit: suffix === "/draft" ? MAX_EDITOR_SAVE_BODY_BYTES : MAX_MUTATION_BODY_BYTES,
    ...(suffix === "/english-publication-retry" ? { englishPublicationRetry: true as const } : {}) };
}

/** サイト側の管理画面を枠で開くための origin とパス、CMS・翻訳の開き方（frame / workspace）。参加者（owner・editor）だけに返す */
async function siteAdminApi(env: Env, identity: AccessIdentity, projectId: string, siteId: string): Promise<Response> {
  if (!await editorMember(env, identity, projectId, siteId)) return json({ error: "forbidden" }, 403);
  const admin = siteAdmin(env as unknown as Record<string, unknown>, projectId, siteId);
  return admin ? json({ origin: admin.origin, paths: admin.paths, cmsView: admin.cmsView, translationsView: admin.translationsView }) : json({ error: "not_connected" }, 404);
}

async function editorMember(env: Env, identity: AccessIdentity, projectId: string, siteId: string): Promise<boolean> {
  const row = await env.DB.prepare(`
    SELECT 1 AS allowed
      FROM project_members AS m
      JOIN sites AS s ON s.project_id = m.project_id
     WHERE m.access_subject = ?1 AND m.project_id = ?2 AND s.id = ?3
       AND m.role IN ('owner', 'editor')
     LIMIT 1
  `).bind(identity.subject, projectId, siteId).first<{ readonly allowed: number }>();
  return row?.allowed === 1;
}

/** そのサイトでの役割（owner / editor）。参加していなければ null。翻訳の BFF が上流へ渡す actor の role に使う。 */
async function editorRole(env: Env, identity: AccessIdentity, projectId: string, siteId: string): Promise<Role | null> {
  const row = await env.DB.prepare(`
    SELECT m.role AS role
      FROM project_members AS m
      JOIN sites AS s ON s.project_id = m.project_id
     WHERE m.access_subject = ?1 AND m.project_id = ?2 AND s.id = ?3
       AND m.role IN ('owner', 'editor')
     LIMIT 1
  `).bind(identity.subject, projectId, siteId).first<{ readonly role: unknown }>();
  const role = row?.role;
  return role === "owner" || role === "editor" ? role : null;
}

async function experienceEditorOwner(env: Env, identity: AccessIdentity): Promise<boolean> {
  const row = await env.DB.prepare(`
    SELECT 1 AS allowed
      FROM project_members AS m
      JOIN sites AS s ON s.project_id = m.project_id
     WHERE m.access_subject = ?1 AND m.project_id = ?2 AND s.id = ?3
       AND m.role = 'owner'
     LIMIT 1
  `).bind(identity.subject, EDITOR_PROJECT_ID, EDITOR_SITE_ID).first<{ readonly allowed: number }>();
  return row?.allowed === 1;
}

async function readBoundedBody(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const requestUrl = new URL(request.url);
  if (request.headers.get("Origin") !== requestUrl.origin || request.headers.get("Sec-Fetch-Site") !== "same-origin") throw new AuthenticationError("invalid editor request origin");
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new AuthenticationError("editor JSON required");
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)) throw new AuthenticationError("editor request body too large");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) { await reader.cancel("editor request body too large"); throw new AuthenticationError("editor request body too large"); }
      chunks.push(chunk.value);
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
    if (!isRecord(parsed)) throw new Error("object required");
  } catch { throw new AuthenticationError("invalid editor JSON"); }
  return body;
}

async function readBoundedResponse(response: Response, maximumBytes = MAX_EDITOR_RESPONSE_BYTES): Promise<unknown> {
  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new BridgeUnavailableError("invalid bridge response media type");
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)) throw new BridgeUnavailableError("bridge response too large");
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) { await reader.cancel("bridge response too large"); throw new BridgeUnavailableError("bridge response too large"); }
      chunks.push(chunk.value);
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown; }
  catch { throw new BridgeUnavailableError("invalid bridge JSON"); }
  // 素材の使用箇所（assets/usages）は配列で返る。それ以外の応答は object。
  if (!isRecord(parsed) && !Array.isArray(parsed)) throw new BridgeUnavailableError("invalid bridge response");
  return parsed;
}

async function signedEditorRequest(
  request: Request,
  identity: AccessIdentity,
  route: EditorRoute,
  bridge: { readonly origin: string; readonly secret: string | undefined }
): Promise<Response> {
  const body = request.method === "GET" ? new Uint8Array() : await readBoundedBody(request, route.bodyLimit);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyBytes = body.slice().buffer;
  const bodyHash = hexadecimal(await crypto.subtle.digest("SHA-256", bodyBytes));
  const message = `v1\n${timestamp}\n${request.method}\n${route.upstreamPath}\n${bodyHash}\n${EDITOR_PROJECT_ID}\n${identity.subject}`;
  const key = await crypto.subtle.importKey("raw", bridgeSecret(bridge.secret).slice().buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = hexadecimal(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, EDITOR_TIMEOUT_MILLISECONDS);
  try {
    const response = await fetch(`${bridge.origin}${route.upstreamPath}`, {
      method: request.method,
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-store",
        ...(request.method === "GET" ? {} : { "Content-Type": "application/json" }),
        "X-NIHO-Studio-Project": EDITOR_PROJECT_ID,
        "X-NIHO-Studio-Subject": identity.subject,
        "X-NIHO-Studio-Timestamp": timestamp,
        "X-NIHO-Studio-Signature": `v1=${signature}`
      },
      ...(request.method === "GET" ? {} : { body: bodyBytes })
    });
    if (response.status >= 300 && response.status < 400) throw new BridgeUnavailableError("bridge redirect rejected");
    const value = await readBoundedResponse(response);
    if (response.status === 409) return json({ error: "conflict" }, 409);
    if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 429 || response.status >= 500) throw new BridgeUnavailableError("bridge service unavailable");
    if (!response.ok) return json({ error: "invalid_request" }, response.status === 400 || response.status === 422 ? 400 : 503);
    return json(value, response.status);
  } catch { throw new BridgeUnavailableError("bridge request failed"); }
  finally { clearTimeout(timeout); request.signal.removeEventListener("abort", abort); }
}

function kamakuraBridgeOperation(route: EditorRoute): KamakuraBridgeOperation {
  if (route.embedOperation === "import") return "embed_import";
  if (route.embedOperation === "status") return "embed_status";
  if (route.assetOperation === "list") return "asset_list";
  if (route.assetOperation === "upload-intent") return "asset_upload_intent";
  if (route.assetOperation === "update") return "asset_update";
  if (route.assetOperation === "usages") return "asset_usages";
  if (route.assetOperation === "resolve") return "asset_resolve";
  if (route.upstreamPath === `${KAMAKURA_EDITOR_UPSTREAM_PREFIX}/catalog`) return "catalog";
  if (route.upstreamPath.endsWith("/draft")) return "draft_save";
  if (route.upstreamPath.endsWith("/release-plan")) return "release_plan";
  if (route.englishPublicationRetry) return "english_publication_retry";
  if (route.upstreamPath.endsWith("/release")) return "release";
  return "page_read";
}

/** 秘密・署名・subject・本文は出さない。support ID・操作・分類・上流の status だけ。 */
function logKamakuraBridgeFailure(error: KamakuraBridgeFailureError): void {
  console.warn("NIHO Studio Kamakura bridge failure", {
    supportId: error.supportId,
    operation: error.operation,
    category: error.category,
    ...(error.upstreamStatus === undefined ? {} : { upstreamStatus: error.upstreamStatus })
  });
}

function kamakuraBridgeFailure(
  supportId: string,
  operation: KamakuraBridgeOperation,
  category: KamakuraBridgeFailureCategory,
  upstreamStatus?: number
): KamakuraBridgeFailureError {
  return new KamakuraBridgeFailureError(supportId, operation, category, upstreamStatus);
}

/**
 * kamakura-site の service binding へ渡す署名つきの header。editor（web-content・素材）と CMS の BFF で共有する。
 * message は `v1\n${timestamp}\n${method}\n${path}\n${sha256hex(body)}\n${project}\n${subject}`。GET の body は空 byte 列。
 */
async function kamakuraSignedHeaders(
  env: Env,
  identity: AccessIdentity,
  method: string,
  upstreamPath: string,
  body: Uint8Array,
  supportId: string,
  operation: KamakuraBridgeOperation
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyHash = hexadecimal(await crypto.subtle.digest("SHA-256", body.slice().buffer));
  const message = `v1\n${timestamp}\n${method}\n${upstreamPath}\n${bodyHash}\n${KAMAKURA_EDITOR_PROJECT_ID}\n${identity.subject}`;
  let secret: Uint8Array;
  try { secret = bridgeSecret(env.KAMAKURA_STUDIO_BRIDGE_SECRET); }
  catch { throw kamakuraBridgeFailure(supportId, operation, "bridge_secret_missing_or_invalid"); }
  let signature: string;
  try {
    const key = await crypto.subtle.importKey("raw", secret.slice().buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    signature = hexadecimal(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  } catch { throw kamakuraBridgeFailure(supportId, operation, "bridge_signing_failed"); }
  return {
    Accept: "application/json",
    "Cache-Control": "no-store",
    ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
    "X-NIHO-Studio-Project": KAMAKURA_EDITOR_PROJECT_ID,
    "X-NIHO-Studio-Subject": identity.subject,
    "X-NIHO-Studio-Request-ID": supportId,
    "X-NIHO-Studio-Timestamp": timestamp,
    "X-NIHO-Studio-Signature": `v1=${signature}`
  };
}

async function signedKamakuraEditorRequest(request: Request, env: Env, identity: AccessIdentity, route: EditorRoute): Promise<Response> {
  const supportId = crypto.randomUUID();
  const operation = kamakuraBridgeOperation(route);
  if (request.method === "GET" && (request.body !== null || ![null, "0"].includes(request.headers.get("Content-Length")))) throw new AuthenticationError("GET body rejected");
  const rawBody = request.method === "GET" ? new Uint8Array() : await readBoundedBody(request, route.bodyLimit);
  let body = route.assetOperation ? validateKamakuraAssetBody(rawBody, route.assetOperation) : rawBody;
  if (route.englishPublicationRetry) {
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)) as unknown; }
    catch { throw new AuthenticationError("invalid english publication retry request"); }
    if (!isRecord(parsed) || Object.keys(parsed).length !== 0) throw new AuthenticationError("invalid english publication retry request");
    body = new TextEncoder().encode("{}");
  }
  const bodyBytes = body.slice().buffer;
  const headers = await kamakuraSignedHeaders(env, identity, request.method, route.upstreamPath, body, supportId, operation);
  const controller = new AbortController();
  let timedOut = false;
  const abortForRequest = () => controller.abort();
  const abortForTimeout = () => { timedOut = true; controller.abort(); };
  request.signal.addEventListener("abort", abortForRequest, { once: true });
  const timeout = setTimeout(abortForTimeout, operation === "release" ? KAMAKURA_RELEASE_TIMEOUT_MILLISECONDS : EDITOR_TIMEOUT_MILLISECONDS);
  try {
    const upstream = new Request(`${KAMAKURA_EDITOR_UPSTREAM_ORIGIN}${route.upstreamPath}`, {
      method: request.method,
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
      headers,
      ...(request.method === "GET" ? {} : { body: bodyBytes })
    });
    const isCatalog = route.upstreamPath === `${KAMAKURA_EDITOR_UPSTREAM_PREFIX}/catalog`;
    let response: Response;
    try { response = await env.KAMAKURA_SITE.fetch(upstream); }
    catch { throw kamakuraBridgeFailure(supportId, operation, timedOut ? "service_binding_timeout" : "service_binding_failed"); }
    if (response.status >= 300 && response.status < 400) throw kamakuraBridgeFailure(supportId, operation, "upstream_redirect_rejected", response.status);
    if (response.status === 409) {
      // 凍結中の保存・公開（kamakura-site#84）は競合と分けて返し、画面で凍結中と案内する。
      const frozen = await readBoundedResponse(response).then((value) => isRecord(value) && value.error === "visual_editor_frozen", () => false);
      if (frozen && !route.englishPublicationRetry) return json({ error: "visual_editor_frozen" }, 409);
      if (!isCatalog) return json({ error: "conflict" }, 409);
      throw kamakuraBridgeFailure(supportId, operation, "upstream_contract_invalid", response.status);
    }
    if (route.assetOperation && (response.status === 413 || response.status === 415 || response.status === 507)) {
      // 素材の拒否（大きさ・形式・容量）は status を保ち、画面が理由を表示できるようにする。本文は読まない。
      await response.body?.cancel();
      return json({ error: "asset_rejected" }, response.status);
    }
    if (response.status === 401 || response.status === 403) throw kamakuraBridgeFailure(supportId, operation, "upstream_auth_rejected", response.status);
    if (response.status === 429) throw kamakuraBridgeFailure(supportId, operation, "upstream_rate_limited", response.status);
    if (response.status >= 500) throw kamakuraBridgeFailure(supportId, operation, "upstream_server_error", response.status);
    if (response.status === 404) {
      if (isCatalog) throw kamakuraBridgeFailure(supportId, operation, "catalog_endpoint_missing", response.status);
      return json({ error: "not_found" }, 404);
    }
    if (isCatalog && !response.ok) throw kamakuraBridgeFailure(supportId, operation, "upstream_contract_invalid", response.status);
    if (!isCatalog && !response.ok) {
      if (response.status === 400 || response.status === 413 || response.status === 422) return json({ error: "invalid_request" }, 400);
      throw kamakuraBridgeFailure(supportId, operation, "upstream_unexpected_4xx", response.status);
    }
    let value: unknown;
    try { value = await readBoundedResponse(response); }
    catch {
      if (timedOut) throw kamakuraBridgeFailure(supportId, operation, "service_binding_timeout");
      if (isCatalog) throw kamakuraBridgeFailure(supportId, operation, "upstream_contract_invalid", response.status);
      throw kamakuraBridgeFailure(supportId, operation, "upstream_invalid_response", response.status);
    }
    if (route.englishPublicationRetry) {
      try { return json(parseEnglishPublicationAccepted(value), response.status); }
      catch { throw kamakuraBridgeFailure(supportId, operation, "upstream_contract_invalid", response.status); }
    }
    if (!isCatalog) return json(value, response.status);
    try { return json(parseKamakuraCatalog(value), response.status); }
    catch (error) {
      if (error instanceof KamakuraCatalogContractError) throw kamakuraBridgeFailure(supportId, operation, "upstream_contract_invalid", response.status);
      throw kamakuraBridgeFailure(supportId, operation, "bridge_processing_failed", response.status);
    }
  } catch (error) {
    if (error instanceof KamakuraBridgeFailureError) throw error;
    if (error instanceof KamakuraCatalogContractError) throw kamakuraBridgeFailure(supportId, operation, "upstream_contract_invalid");
    throw kamakuraBridgeFailure(supportId, operation, "bridge_processing_failed");
  }
  finally { clearTimeout(timeout); request.signal.removeEventListener("abort", abortForRequest); }
}

async function signedKamakuraAssetPreview(request: Request, env: Env, identity: AccessIdentity, assetId: string): Promise<Response> {
  if (!KAMAKURA_UPLOAD_ID.test(assetId)) return json({ error: "not_found" }, 404);
  if (request.body !== null || ![null, "0"].includes(request.headers.get("Content-Length"))) return json({ error: "invalid_request" }, 400);
  if (request.headers.get("Sec-Fetch-Site") !== "same-origin") return json({ error: "invalid_request" }, 400);
  const path = `${KAMAKURA_EDITOR_UPSTREAM_PREFIX}/assets/preview`;
  const method = "POST";
  const body = new TextEncoder().encode(JSON.stringify({ siteId: KAMAKURA_EDITOR_SITE_ID, assetId }));
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyHash = hexadecimal(await crypto.subtle.digest("SHA-256", body.slice().buffer));
  const message = `v1\n${timestamp}\n${method}\n${path}\n${bodyHash}\n${KAMAKURA_EDITOR_PROJECT_ID}\n${identity.subject}`;
  const key = await crypto.subtle.importKey("raw", bridgeSecret(env.KAMAKURA_STUDIO_BRIDGE_SECRET).slice().buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = hexadecimal(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, EDITOR_TIMEOUT_MILLISECONDS);
  let streaming = false;
  const cleanup = () => { clearTimeout(timeout); request.signal.removeEventListener("abort", abort); };
  try {
    const signedRequest = new Request(`${KAMAKURA_EDITOR_UPSTREAM_ORIGIN}${path}`, {
      method, cache: "no-store", redirect: "manual", signal: controller.signal,
      headers: {
        Accept: "application/json", "Content-Type": "application/json", "Cache-Control": "no-store",
        "X-NIHO-Studio-Project": KAMAKURA_EDITOR_PROJECT_ID, "X-NIHO-Studio-Subject": identity.subject,
        "X-NIHO-Studio-Timestamp": timestamp, "X-NIHO-Studio-Signature": `v1=${signature}`
      }, body: body.slice().buffer
    });
    const imageResponse = await env.KAMAKURA_SITE.fetch(signedRequest);
    if (imageResponse.status >= 300 && imageResponse.status < 400) throw new BridgeUnavailableError("preview redirect rejected");
    if (imageResponse.status === 404) { await imageResponse.body?.cancel(); return json({ error: "not_found" }, 404); }
    if (imageResponse.status === 401 || imageResponse.status === 403 || imageResponse.status === 429 || imageResponse.status >= 500) throw new BridgeUnavailableError("preview service unavailable");
    if (!imageResponse.ok) {
      await imageResponse.body?.cancel();
      return json({ error: "invalid_request" }, imageResponse.status === 400 || imageResponse.status === 413 || imageResponse.status === 422 ? 400 : 503);
    }
    const contentType = imageResponse.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!KAMAKURA_ASSET_IMAGE_TYPES.has(contentType) || !imageResponse.body) {
      await imageResponse.body?.cancel();
      return json({ error: "invalid_request" }, 503);
    }
    clearTimeout(timeout);
    const reader = imageResponse.body.getReader();
    const streamedBody = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        try {
          const chunk = await reader.read();
          if (chunk.done) { streamController.close(); cleanup(); }
          else streamController.enqueue(chunk.value);
        } catch (error) { streamController.error(error); cleanup(); }
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { controller.abort(); cleanup(); } }
    });
    const headers = securityHeaders(contentType);
    const streamedResponse = new Response(streamedBody, { status: 200, headers });
    streaming = true;
    return streamedResponse;
  } catch {
    throw new BridgeUnavailableError("preview request failed");
  } finally { if (!streaming) cleanup(); }
}

/* ---------- Kamakura の CMS（記事・サークル・会社）の BFF ---------- */

type KamakuraCmsOperation = "schema" | "list" | "read" | "english-publication-read" | "english-publication-retry" | "create" | "draft" | "publish" | "discard-draft" | "unpublish" | "duplicate" | "remove" | "schedule" | "cancel-schedule" | "retry-schedule" | "reorder" | "bulk" | "upload-intent";
type KamakuraCmsRoute = { readonly operation: KamakuraCmsOperation; readonly upstreamPath: string; readonly collectionId: string | null; readonly itemId: string | null };
type KamakuraCmsOperationSpec = {
  readonly method: "GET" | "POST" | "PUT"; readonly success: readonly (200 | 201 | 202)[]; readonly log: KamakuraBridgeOperation;
  /** 必ず要る key（null は本文なし）。optionalKeys は付けてもよい key。それ以外の key は拒否。 */
  readonly bodyKeys: readonly string[] | null; readonly optionalKeys?: readonly string[];
};

/** 操作ごとの method・上流の成功の status・log の operation・ブラウザの本文の key の集合（actor は BFF が入れる）。 */
const KAMAKURA_CMS_OPERATIONS: Readonly<Record<KamakuraCmsOperation, KamakuraCmsOperationSpec>> = {
  schema: { method: "GET", success: [200], log: "cms_schema", bodyKeys: null },
  list: { method: "GET", success: [200], log: "cms_list", bodyKeys: null },
  read: { method: "GET", success: [200], log: "cms_read", bodyKeys: null },
  "english-publication-read": { method: "GET", success: [200], log: "cms_english_publication_read", bodyKeys: null },
  "english-publication-retry": { method: "POST", success: [200], log: "cms_english_publication_retry", bodyKeys: [] },
  create: { method: "POST", success: [201], log: "cms_create", bodyKeys: [] },
  draft: { method: "PUT", success: [200], log: "cms_draft_save", bodyKeys: ["version", "values"] },
  publish: { method: "POST", success: [202], log: "cms_publish", bodyKeys: ["version"], optionalKeys: ["redirect"] },
  "discard-draft": { method: "POST", success: [200], log: "cms_discard_draft", bodyKeys: ["version"] },
  unpublish: { method: "POST", success: [202], log: "cms_unpublish", bodyKeys: ["version"] },
  duplicate: { method: "POST", success: [201], log: "cms_duplicate", bodyKeys: ["version"] },
  remove: { method: "POST", success: [200], log: "cms_remove", bodyKeys: ["version"], optionalKeys: ["redirectTo"] },
  schedule: { method: "POST", success: [200], log: "cms_schedule", bodyKeys: ["version", "at"], optionalKeys: ["redirect"] },
  "cancel-schedule": { method: "POST", success: [200], log: "cms_cancel_schedule", bodyKeys: ["version"] },
  "retry-schedule": { method: "POST", success: [200], log: "cms_retry_schedule", bodyKeys: ["version"] },
  reorder: { method: "POST", success: [202, 200], log: "cms_reorder", bodyKeys: ["ids", "from", "to"] },
  bulk: { method: "POST", success: [202, 200], log: "cms_bulk", bodyKeys: ["action", "items"] },
  "upload-intent": { method: "POST", success: [201], log: "cms_upload_intent", bodyKeys: ["collectionId", "name", "mimeType", "bytes"] }
};
const KAMAKURA_CMS_ITEM_ACTIONS: ReadonlySet<string> = new Set(["draft", "publish", "discard-draft", "unpublish", "duplicate", "remove", "schedule", "cancel-schedule", "retry-schedule"]);
const KAMAKURA_CMS_BULK_ACTIONS: ReadonlySet<unknown> = new Set(["publish", "unpublish", "remove"]);

/** action は `/cms` より後ろ。collection と item の ID は固定の形だけを通し、上流のパスはこの action をそのまま使う。 */
function kamakuraCmsRoute(action: string, method: string): KamakuraCmsRoute | "method_not_allowed" | null {
  let operation: KamakuraCmsOperation, collectionId: string | null = null, itemId: string | null = null;
  const listAction = /^\/collections\/([^/]+)\/(reorder|bulk)$/u.exec(action);
  if (action === "/schema") operation = "schema";
  else if (action === "/uploads/intent") operation = "upload-intent";
  else if (listAction) {
    if (!isKamakuraCmsCollectionId(listAction[1])) return null;
    collectionId = listAction[1];
    operation = listAction[2] as "reorder" | "bulk";
  } else {
    const match = /^\/collections\/([^/]+)\/items(?:\/([^/]+)(?:\/([^/]+))?)?$/u.exec(action);
    if (!match || !isKamakuraCmsCollectionId(match[1])) return null;
    collectionId = match[1];
    if (match[2] === undefined) {
      if (method !== "GET" && method !== "POST") return "method_not_allowed";
      operation = method === "GET" ? "list" : "create";
    } else {
      if (!isKamakuraCmsItemId(match[2])) return null;
      itemId = match[2];
      if (match[3] === undefined) operation = "read";
      else if (match[3] === "english-publication") {
        if (method !== "GET" && method !== "POST") return "method_not_allowed";
        operation = method === "GET" ? "english-publication-read" : "english-publication-retry";
      } else if (KAMAKURA_CMS_ITEM_ACTIONS.has(match[3])) operation = match[3] as KamakuraCmsOperation;
      else return null;
    }
  }
  if (method !== KAMAKURA_CMS_OPERATIONS[operation].method) return "method_not_allowed";
  return { operation, upstreamPath: `${KAMAKURA_CMS_UPSTREAM_PREFIX}${action}`, collectionId, itemId };
}

/** ブラウザの本文を操作ごとの key の集合で確かめ、BFF が確かめた email を actor に入れて JSON を作り直す。actor を送ってきたら拒否。 */
function kamakuraCmsBody(route: KamakuraCmsRoute, raw: Uint8Array, identity: AccessIdentity): Uint8Array {
  const spec = KAMAKURA_CMS_OPERATIONS[route.operation], keys = spec.bodyKeys, optionalKeys = spec.optionalKeys ?? [];
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown; }
  catch { throw new AuthenticationError("invalid CMS JSON"); }
  if (!isRecord(parsed) || keys === null) throw new AuthenticationError("invalid CMS body");
  const body = parsed;
  if (keys.some((key) => !Object.hasOwn(body, key)) || Object.keys(body).some((key) => !keys.includes(key) && !optionalKeys.includes(key))) throw new AuthenticationError("unexpected CMS body fields");
  const actor = { email: identity.email };
  if (route.operation === "create") return new TextEncoder().encode(JSON.stringify({ actor }));
  if (route.operation === "english-publication-retry") return new TextEncoder().encode(JSON.stringify({ actor }));
  if (route.operation === "reorder") {
    const { ids, from, to } = body;
    if (!Array.isArray(ids) || ids.length < 2 || ids.length > KAMAKURA_CMS_LIMITS.reorderIds || !ids.every((id) => isKamakuraCmsItemId(id)) || new Set(ids).size !== ids.length) throw new AuthenticationError("invalid CMS reorder ids");
    const index = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < ids.length;
    if (!index(from) || !index(to) || from === to) throw new AuthenticationError("invalid CMS reorder position");
    return new TextEncoder().encode(JSON.stringify({ ids, from, to, actor }));
  }
  if (route.operation === "bulk") {
    const { action, items } = body;
    if (!KAMAKURA_CMS_BULK_ACTIONS.has(action) || !Array.isArray(items) || items.length < 1 || items.length > KAMAKURA_CMS_LIMITS.bulkItems) throw new AuthenticationError("invalid CMS bulk request");
    const checked = items.map((entry: unknown) => {
      if (!isRecord(entry) || Object.keys(entry).length !== 2 || !isKamakuraCmsItemId(entry.id) || !isKamakuraCmsVersion(entry.version)) throw new AuthenticationError("invalid CMS bulk item");
      return { id: entry.id, version: entry.version };
    });
    if (new Set(checked.map((entry) => entry.id)).size !== checked.length) throw new AuthenticationError("duplicate CMS bulk item");
    return new TextEncoder().encode(JSON.stringify({ action, items: checked, actor }));
  }
  if (route.operation === "upload-intent") {
    const { collectionId, name, mimeType, bytes } = parsed;
    if (!isKamakuraCmsCollectionId(collectionId) || !isKamakuraCmsLine(name, KAMAKURA_CMS_LIMITS.uploadNameLength) || typeof mimeType !== "string" || !KAMAKURA_CMS_IMAGE_TYPES.has(mimeType)
      || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > KAMAKURA_CMS_LIMITS.imageBytes) throw new AuthenticationError("invalid CMS upload request");
    return new TextEncoder().encode(JSON.stringify({ collectionId, name, mimeType, bytes, actor }));
  }
  const version = body.version;
  if (!isKamakuraCmsVersion(version)) throw new AuthenticationError("invalid CMS version");
  if (route.operation === "draft") {
    let values: unknown;
    try { values = parseKamakuraCmsValues(body.values); }
    catch { throw new AuthenticationError("invalid CMS values"); }
    return new TextEncoder().encode(JSON.stringify({ version, values, actor }));
  }
  // 公開・予約の redirect（前のアドレスから移すか）は boolean だけ。無ければ送らない（上流の既定は true）。
  const redirect = body.redirect;
  if (redirect !== undefined && typeof redirect !== "boolean") throw new AuthenticationError("invalid CMS redirect");
  const redirectPart = redirect === undefined ? {} : { redirect };
  if (route.operation === "schedule") {
    const at = normalizeKamakuraCmsTimestamp(body.at);
    if (at === null) throw new AuthenticationError("invalid CMS schedule");
    return new TextEncoder().encode(JSON.stringify({ version, at, ...redirectPart, actor }));
  }
  if (route.operation === "publish") return new TextEncoder().encode(JSON.stringify({ version, ...redirectPart, actor }));
  if (route.operation === "remove") {
    // 削除の移動先: null（移さない）か、サイトの中のパス。何を受け付けるか（同じコレクションの公開中の項目・一覧）は上流が確かめる。
    const redirectTo = body.redirectTo;
    if (redirectTo !== undefined && redirectTo !== null && !isKamakuraCmsSitePath(redirectTo)) throw new AuthenticationError("invalid CMS redirect target");
    return new TextEncoder().encode(JSON.stringify({ version, ...(redirectTo === undefined ? {} : { redirectTo }), actor }));
  }
  return new TextEncoder().encode(JSON.stringify({ version, actor }));
}

/** 上流の成功の応答を契約の parser で確かめ、既知の field だけにする。 */
function kamakuraCmsSuccess(route: KamakuraCmsRoute, value: unknown, status: number): unknown {
  const itemId = route.itemId ?? undefined;
  switch (route.operation) {
    case "schema": return parseKamakuraCmsSchema(value);
    case "list": return parseKamakuraCmsList(value, route.collectionId!);
    case "read": return parseKamakuraCmsItemEnvelope(value, "ready", itemId);
    case "english-publication-read": return parseKamakuraCmsEnglishPublications(value, "ready", route.collectionId!, route.itemId!);
    case "english-publication-retry": return parseKamakuraCmsEnglishPublications(value, "accepted", route.collectionId!, route.itemId!);
    case "create": return parseKamakuraCmsItemEnvelope(value, "created");
    case "duplicate": {
      const created = parseKamakuraCmsItemEnvelope(value, "created");
      if (created.item.id === route.itemId) throw new KamakuraCmsContractError("response.item.id");
      return created;
    }
    case "publish": case "unpublish": return parseKamakuraCmsItemEnvelope(value, "publishing", itemId);
    case "remove": return parseKamakuraCmsRemoved(value);
    case "upload-intent": return parseKamakuraCmsUploadIntent(value);
    case "draft": case "discard-draft": case "schedule": case "cancel-schedule": case "retry-schedule": return parseKamakuraCmsItemEnvelope(value, "saved", itemId);
    // 並べ替え・まとめての操作は commit したら 202 publishing、commit が無ければ（同じ番号どうしの入れ替え・下書きを捨てただけ）200 saved
    case "reorder":
    case "bulk": return parseKamakuraCmsListChange(value, status === 202 ? "publishing" : "saved");
  }
}

async function signedKamakuraCmsRequest(request: Request, env: Env, identity: AccessIdentity, route: KamakuraCmsRoute): Promise<Response> {
  const supportId = crypto.randomUUID();
  const spec = KAMAKURA_CMS_OPERATIONS[route.operation];
  const operation = spec.log, method = spec.method;
  if (method === "GET" && (request.body !== null || ![null, "0"].includes(request.headers.get("Content-Length")))) throw new AuthenticationError("GET body rejected");
  const body = method === "GET"
    ? new Uint8Array()
    : kamakuraCmsBody(route, await readBoundedBody(request, route.operation === "draft" ? KAMAKURA_CMS_LIMITS.draftBodyBytes
      : route.operation === "reorder" || route.operation === "bulk" ? KAMAKURA_CMS_LIMITS.listBodyBytes : KAMAKURA_CMS_LIMITS.bodyBytes), identity);
  const headers = await kamakuraSignedHeaders(env, identity, method, route.upstreamPath, body, supportId, operation);
  const responseLimit = route.operation === "upload-intent" || route.operation === "english-publication-read" || route.operation === "english-publication-retry"
    ? KAMAKURA_CMS_LIMITS.bodyBytes : KAMAKURA_CMS_LIMITS.responseBytes;
  const controller = new AbortController();
  let timedOut = false;
  const abortForRequest = () => controller.abort();
  const abortForTimeout = () => { timedOut = true; controller.abort(); };
  request.signal.addEventListener("abort", abortForRequest, { once: true });
  // 読み取りは 12 秒。公開・非公開・削除などの書き込みは kamakura-site で commit まで行うので 30 秒。
  const timeout = setTimeout(abortForTimeout, method === "GET" ? EDITOR_TIMEOUT_MILLISECONDS : KAMAKURA_RELEASE_TIMEOUT_MILLISECONDS);
  const read = async (response: Response): Promise<unknown> => {
    try { return await readBoundedResponse(response, responseLimit); }
    catch { throw kamakuraBridgeFailure(supportId, operation, timedOut ? "service_binding_timeout" : "upstream_invalid_response", response.status); }
  };
  const checked = (response: Response, parse: () => unknown): Response => {
    try { return json(parse(), response.status); }
    catch (error) {
      throw kamakuraBridgeFailure(supportId, operation, error instanceof KamakuraCmsContractError ? "upstream_contract_invalid" : "bridge_processing_failed", response.status);
    }
  };
  const discard = async (response: Response) => { try { await response.body?.cancel(); } catch { /* 本文は使わない */ } };
  try {
    const upstream = new Request(`${KAMAKURA_EDITOR_UPSTREAM_ORIGIN}${route.upstreamPath}`, {
      method, cache: "no-store", redirect: "manual", signal: controller.signal, headers,
      ...(method === "GET" ? {} : { body: body.slice().buffer })
    });
    let response: Response;
    try { response = await env.KAMAKURA_SITE.fetch(upstream); }
    catch { throw kamakuraBridgeFailure(supportId, operation, timedOut ? "service_binding_timeout" : "service_binding_failed"); }
    const status = response.status;
    if (status >= 300 && status < 400) throw kamakuraBridgeFailure(supportId, operation, "upstream_redirect_rejected", status);
    if (status === 401 || status === 403) throw kamakuraBridgeFailure(supportId, operation, "upstream_auth_rejected", status);
    if (status === 429) throw kamakuraBridgeFailure(supportId, operation, "upstream_rate_limited", status);
    if (status >= 500) throw kamakuraBridgeFailure(supportId, operation, "upstream_server_error", status);
    if (status === 409 && route.operation === "english-publication-retry") {
      await discard(response);
      return json({ error: "conflict" }, 409);
    }
    if (status === 409 && route.itemId !== null) {
      const value = await read(response);
      return checked(response, () => parseKamakuraCmsConflict(value, route.itemId!));
    }
    if (status === 409 && (route.operation === "reorder" || route.operation === "bulk")) {
      const value = await read(response);
      return checked(response, () => parseKamakuraCmsListConflict(value));
    }
    if (status === 422) {
      const value = await read(response);
      return checked(response, () => parseKamakuraCmsInvalid(value));
    }
    if ((status === 413 || status === 415) && route.operation === "upload-intent") { await discard(response); return json({ error: "image_rejected" }, status); }
    if (status === 404) {
      await discard(response);
      // schema が無いのは鎌倉の Worker の endpoint が未配備。ほかの 404 はコレクション・項目が無い。
      if (route.operation === "schema") throw kamakuraBridgeFailure(supportId, operation, "cms_endpoint_missing", status);
      return json({ error: "not_found" }, 404);
    }
    if (status === 400 || status === 413) { await discard(response); return json({ error: "invalid_request" }, 400); }
    if (!(spec.success as readonly number[]).includes(status)) {
      await discard(response);
      throw kamakuraBridgeFailure(supportId, operation, status >= 200 && status < 300 ? "upstream_contract_invalid" : "upstream_unexpected_4xx", status);
    }
    const value = await read(response);
    return checked(response, () => kamakuraCmsSuccess(route, value, status));
  } catch (error) {
    if (error instanceof KamakuraBridgeFailureError) throw error;
    throw kamakuraBridgeFailure(supportId, operation, "bridge_processing_failed");
  } finally { clearTimeout(timeout); request.signal.removeEventListener("abort", abortForRequest); }
}

/** `/api/projects/project-kamakura/sites/kamakura/cms/*`。鎌倉以外は 404。要求ごとに D1 の owner / editor を確かめる。 */
async function kamakuraCmsApi(request: Request, env: Env, identity: AccessIdentity, url: URL, projectId: string, siteId: string, action: string): Promise<Response> {
  if (projectId !== KAMAKURA_EDITOR_PROJECT_ID || siteId !== KAMAKURA_EDITOR_SITE_ID) return json({ error: "not_found" }, 404);
  if (url.href.includes("?")) return json({ error: "invalid_request" }, 400);
  const route = kamakuraCmsRoute(action, request.method);
  if (route === null) return json({ error: "not_found" }, 404);
  if (route === "method_not_allowed") return json({ error: "method_not_allowed" }, 405);
  if (!await editorMember(env, identity, projectId, siteId)) return json({ error: "forbidden" }, 403);
  try { return await signedKamakuraCmsRequest(request, env, identity, route); }
  catch (error) {
    if (error instanceof AuthenticationError) return json({ error: "invalid_request" }, 400);
    throw error;
  }
}

/* ---------- Kamakura の翻訳（LocalizationWorkspace）の BFF ---------- */

type KamakuraLocalizationOperation =
  "overview" | "list" | "list-after" | "item" | "command" | "translate" | "job" | "catalog" | "preview" | "release" | "prepare" | "apply" | "settings" | "upload-intent" | "editor-site" | "editor-page" | "editor-snapshot" | "editor-save" | "editor-command";
type KamakuraLocalizationRoute = { readonly operation: KamakuraLocalizationOperation; readonly upstreamPath: string; readonly itemKey: string | null; readonly jobId: string | null; readonly pageId: string | null };
type KamakuraLocalizationSpec = { readonly method: "POST" | "PUT"; readonly log: KamakuraBridgeOperation; readonly bodyKeys: readonly string[] | null; readonly long: boolean };
type KamakuraLocalizationActor = { readonly email: string; readonly role: Role };

/**
 * 操作ごとの method・log の operation・ブラウザの本文の key の集合（command は action ごと。actor は BFF が入れる）・待ち時間。
 * long は GitHub や翻訳サービスを待つ操作（概要・原文の取り込み・翻訳の依頼・プレビューの材料・公開の履歴と準備と反映）で 30 秒、ほかは 12 秒。
 */
const KAMAKURA_LOCALIZATION_OPERATIONS: Readonly<Record<KamakuraLocalizationOperation, KamakuraLocalizationSpec>> = {
  overview: { method: "POST", log: "localization_overview", bodyKeys: [], long: true },
  list: { method: "POST", log: "localization_list", bodyKeys: [], long: false },
  "list-after": { method: "POST", log: "localization_list", bodyKeys: [], long: false },
  item: { method: "POST", log: "localization_item", bodyKeys: [], long: false },
  command: { method: "POST", log: "localization_command", bodyKeys: null, long: false },
  translate: { method: "POST", log: "localization_translate", bodyKeys: ["itemKey", "operationId", "unitIds"], long: true },
  job: { method: "POST", log: "localization_job", bodyKeys: [], long: false },
  catalog: { method: "POST", log: "localization_catalog", bodyKeys: [], long: true },
  preview: { method: "POST", log: "localization_preview", bodyKeys: ["itemKey", "previewId", "cursor"], long: true },
  release: { method: "POST", log: "localization_release", bodyKeys: [], long: true },
  prepare: { method: "POST", log: "localization_release_prepare", bodyKeys: ["operation", "releaseId", "expectedVersion", "expectedCurrentVersion", "resumeToken"], long: true },
  apply: { method: "POST", log: "localization_release_apply", bodyKeys: ["confirmationToken", "resumeToken"], long: true },
  settings: { method: "PUT", log: "localization_settings", bodyKeys: null, long: false },
  "upload-intent": { method: "POST", log: "localization_upload_intent", bodyKeys: ["itemKey", "unitId", "name", "mimeType", "bytes"], long: false },
  "editor-site": { method: "POST", log: "localization_editor_site", bodyKeys: [], long: true },
  "editor-page": { method: "POST", log: "localization_editor_page", bodyKeys: [], long: true },
  "editor-snapshot": { method: "POST", log: "localization_editor_snapshot", bodyKeys: [], long: true },
  "editor-save": { method: "POST", log: "localization_editor_save", bodyKeys: ["document", "expectedSourceVersion", "expectedVersion", "expectedOverlayVersion"], long: true },
  "editor-command": { method: "POST", log: "localization_editor_command", bodyKeys: null, long: true }
};
/** 下の階層を持たない経路（`/localization` より後ろ）。 */
const KAMAKURA_LOCALIZATION_FIXED: Readonly<Record<string, KamakuraLocalizationOperation>> = {
  "/overview": "overview", "/items": "list", "/catalog/advance": "catalog", "/preview/items": "preview", "/release": "release",
  "/release/prepare": "prepare", "/release/apply": "apply", "/settings": "settings", "/uploads/intent": "upload-intent", "/editor/site": "editor-site"
};
/** command の action ごとに足す本文の key。 */
const KAMAKURA_LOCALIZATION_COMMAND_KEYS: Readonly<Record<string, readonly string[]>> = {
  "set-value": ["value"], "adopt-candidate": ["candidateId"], "review-current": [], "clear-value": [], "set-image": ["image"], "review-image": []
};
const KAMAKURA_EDITOR_LOCALIZATION_COMMAND_KEYS: Readonly<Record<string, readonly string[]>> = {
  "request-translation": [], "adopt-candidate": ["unitId", "candidateVersion"], "review-current": ["unitId"],
  "set-value": ["unitId", "value", "sourceFingerprint", "expectedEntryVersion"]
};
// 形は W1 の契約（src/localization-workspace-model.ts の parser）と同じ
const LOCALIZATION_UNIT_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,299}$/u;
const LOCALIZATION_SHORT_ID = /^[A-Za-z0-9_-]{1,80}$/u;
const LOCALIZATION_CURSOR = /^[A-Za-z0-9_-]{1,512}$/u;
const LOCALIZATION_OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const LOCALIZATION_RELEASE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u;
const LOCALIZATION_TOKEN = /^[A-Za-z0-9._~+/=-]{1,512}$/u;
const RESERVED_LOCALIZATION_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** action は `/localization` より後ろ。itemKey・cursor・jobId は固定の形だけを通し、上流のパスはこの action をそのまま使う。 */
function kamakuraLocalizationRoute(action: string, method: string): KamakuraLocalizationRoute | "method_not_allowed" | null {
  let operation: KamakuraLocalizationOperation, itemKey: string | null = null, jobId: string | null = null, pageId: string | null = null;
  const after = /^\/items\/after\/([^/]+)$/u.exec(action);
  const item = /^\/items\/([^/]+)(?:\/(command|translate))?$/u.exec(action);
  const job = /^\/jobs\/([^/]+)$/u.exec(action);
  const editorPage = /^\/editor\/pages\/([^/]+)(?:\/(snapshot|save|command))?$/u.exec(action);
  if (Object.hasOwn(KAMAKURA_LOCALIZATION_FIXED, action)) operation = KAMAKURA_LOCALIZATION_FIXED[action]!;
  // 鎌倉の Worker と同じく items/after/<cursor> は一覧の続き（items/after だけなら 1 件）
  else if (after) {
    if (!LOCALIZATION_CURSOR.test(after[1]!)) return null;
    operation = "list-after";
  } else if (item) {
    const key = item[1], suffix = item[2];
    if (!isLocalizationItemKey(key)) return null;
    itemKey = key;
    operation = suffix === "command" || suffix === "translate" ? suffix : "item";
  } else if (job) {
    if (!LOCALIZATION_OPAQUE_ID.test(job[1]!) || RESERVED_LOCALIZATION_SEGMENTS.has(job[1]!)) return null;
    jobId = job[1]!;
    operation = "job";
  } else if (editorPage) {
    if (!KAMAKURA_COMMON_PAGE_ID.test(editorPage[1]!)) return null;
    pageId = editorPage[1]!;
    operation = editorPage[2] === "snapshot" ? "editor-snapshot" : editorPage[2] === "save" ? "editor-save" : editorPage[2] === "command" ? "editor-command" : "editor-page";
  } else return null;
  if (method !== KAMAKURA_LOCALIZATION_OPERATIONS[operation].method) return "method_not_allowed";
  return { operation, upstreamPath: `${KAMAKURA_LOCALIZATION_UPSTREAM_PREFIX}${action}`, itemKey, jobId, pageId };
}

function invalidLocalizationBody(what: string): never {
  throw new AuthenticationError(`invalid localization ${what}`);
}

/** ブラウザの本文の値を操作ごとに確かめ、上流へ渡す値だけで作り直す（actor は含めない）。 */
function kamakuraLocalizationValues(route: KamakuraLocalizationRoute, body: Record<string, unknown>): Record<string, unknown> {
  const itemKey = (value: unknown, expected: string | null) => {
    if (!isLocalizationItemKey(value) || (expected !== null && value !== expected)) invalidLocalizationBody("item key");
    return value;
  };
  const unitId = (value: unknown) => {
    if (typeof value !== "string" || !LOCALIZATION_UNIT_ID.test(value)) invalidLocalizationBody("unit");
    return value;
  };
  const version = (value: unknown) => {
    if (!isKamakuraCmsVersion(value)) invalidLocalizationBody("version");
    return value;
  };
  const operationId = (value: unknown) => {
    if (!isLocalizationOperationId(value)) invalidLocalizationBody("operation");
    return value;
  };
  const token = (value: unknown) => {
    if (value !== null && (typeof value !== "string" || !LOCALIZATION_TOKEN.test(value))) invalidLocalizationBody("token");
    return value as string | null;
  };
  const editorVersions = () => {
    if (typeof body.expectedSourceVersion !== "string" || !/^p\.[0-9a-f]{64}$/u.test(body.expectedSourceVersion)
      || typeof body.expectedVersion !== "string" || !/^l\.[0-9a-f]{64}$/u.test(body.expectedVersion)
      || !Number.isSafeInteger(body.expectedOverlayVersion) || (body.expectedOverlayVersion as number) < 1) invalidLocalizationBody("editor versions");
    return { expectedSourceVersion: body.expectedSourceVersion, expectedVersion: body.expectedVersion, expectedOverlayVersion: body.expectedOverlayVersion };
  };
  switch (route.operation) {
    case "overview": case "list": case "list-after": case "item": case "job": case "catalog": case "release": case "editor-site": case "editor-page": case "editor-snapshot":
      return {};
    case "command": {
      const base = {
        itemKey: itemKey(body.itemKey, route.itemKey), operationId: operationId(body.operationId), action: body.action, unitId: unitId(body.unitId),
        expectedVersion: version(body.expectedVersion), expectedSourceVersion: version(body.expectedSourceVersion)
      };
      if (body.action === "set-value") {
        let value: unknown;
        try { value = parseLocalizationValue(body.value, typeof body.value === "string" ? "text" : "rich-text"); }
        catch { invalidLocalizationBody("value"); }
        return { ...base, value };
      }
      if (body.action === "adopt-candidate") {
        if (typeof body.candidateId !== "string" || !LOCALIZATION_OPAQUE_ID.test(body.candidateId)) invalidLocalizationBody("candidate");
        return { ...base, candidateId: body.candidateId };
      }
      if (body.action === "set-image") {
        if (body.image === null) return { ...base, image: null };
        // 鎌倉の Worker が受けるのは公開画像の URL（{ kind: "image-url", src }）だけ。どの URL を使えるかは鎌倉の Worker が確かめる
        let image: ReturnType<typeof parseLocalizationValue>;
        try { image = parseLocalizationValue(body.image, "asset"); }
        catch { invalidLocalizationBody("image"); }
        if (typeof image !== "object" || image.kind !== "image-url" || image.srcset !== undefined) invalidLocalizationBody("image");
        return { ...base, image: { kind: "image-url", src: image.src } };
      }
      return base;
    }
    case "translate": {
      const ids = body.unitIds;
      if (ids !== null && (!Array.isArray(ids) || ids.length > LOCALIZATION_LIMITS.units || new Set(ids).size !== ids.length)) invalidLocalizationBody("units");
      return { itemKey: itemKey(body.itemKey, route.itemKey), operationId: operationId(body.operationId), unitIds: ids === null ? null : (ids as unknown[]).map(unitId) };
    }
    case "preview": {
      if (typeof body.previewId !== "string" || !LOCALIZATION_SHORT_ID.test(body.previewId) || RESERVED_LOCALIZATION_SEGMENTS.has(body.previewId)) invalidLocalizationBody("preview");
      if (body.cursor !== null && (typeof body.cursor !== "string" || !LOCALIZATION_CURSOR.test(body.cursor))) invalidLocalizationBody("cursor");
      return { itemKey: itemKey(body.itemKey, null), previewId: body.previewId, cursor: body.cursor };
    }
    case "prepare": {
      const operation = body.operation, releaseId = body.releaseId;
      if (operation !== "publish" && operation !== "rollback") invalidLocalizationBody("release operation");
      // 公開は行き先なし、戻しは行き先の版が要る
      if (operation === "publish" ? releaseId !== null : typeof releaseId !== "string" || !LOCALIZATION_RELEASE_ID.test(releaseId)) invalidLocalizationBody("release");
      const current = body.expectedCurrentVersion === null ? null : version(body.expectedCurrentVersion);
      return { operation, releaseId, expectedVersion: version(body.expectedVersion), expectedCurrentVersion: current, resumeToken: token(body.resumeToken) };
    }
    case "apply": {
      const confirmationToken = token(body.confirmationToken), resumeToken = token(body.resumeToken);
      if ((confirmationToken === null) === (resumeToken === null)) invalidLocalizationBody("release token");
      return { confirmationToken, resumeToken };
    }
    case "settings": {
      const expectedVersion = version(body.expectedVersion);
      if (Object.hasOwn(body, "autoDraft")) {
        if (typeof body.autoDraft !== "boolean") invalidLocalizationBody("settings");
        return { expectedVersion, autoDraft: body.autoDraft };
      }
      return { expectedVersion, reviewGlossaryVersion: version(body.reviewGlossaryVersion) };
    }
    case "upload-intent": {
      const { name, mimeType, bytes } = body;
      if (!isKamakuraCmsLine(name, KAMAKURA_LOCALIZATION_LIMITS.uploadNameLength) || typeof mimeType !== "string" || !KAMAKURA_LOCALIZATION_IMAGE_TYPES.has(mimeType)
        || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > KAMAKURA_LOCALIZATION_LIMITS.imageBytes) invalidLocalizationBody("upload");
      return { itemKey: itemKey(body.itemKey, null), unitId: unitId(body.unitId), name, mimeType, bytes };
    }
    case "editor-save": {
      const document = body.document;
      if (!isRecord(document) || document.schemaVersion !== 1 || document.siteId !== KAMAKURA_EDITOR_SITE_ID || document.pageId !== route.pageId
        || document.locale !== "en" || !Number.isSafeInteger(document.revision) || (document.revision as number) < 1
        || typeof document.title !== "string" || !Array.isArray(document.body)) invalidLocalizationBody("editor document");
      return { document, ...editorVersions() };
    }
    case "editor-command": {
      const versions = editorVersions(), action = body.action;
      if (action === "request-translation") return { action, ...versions };
      const id = unitId(body.unitId);
      if (action === "adopt-candidate") {
        if (!Number.isSafeInteger(body.candidateVersion) || (body.candidateVersion as number) < 1) invalidLocalizationBody("candidate version");
        return { action, unitId: id, candidateVersion: body.candidateVersion, ...versions };
      }
      if (action === "review-current") return { action, unitId: id, ...versions };
      if (action === "set-value") {
        if (typeof body.sourceFingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(body.sourceFingerprint)
          || !Number.isSafeInteger(body.expectedEntryVersion) || (body.expectedEntryVersion as number) < 0) invalidLocalizationBody("editor unit version");
        let value: unknown;
        try { value = parseLocalizationValue(body.value, typeof body.value === "string" ? "text" : isRecord(body.value) && body.value.kind === "rich-text" ? "rich-text" : "asset"); }
        catch { invalidLocalizationBody("editor value"); }
        return { action, unitId: id, value, sourceFingerprint: body.sourceFingerprint, expectedEntryVersion: body.expectedEntryVersion, ...versions };
      }
      invalidLocalizationBody("editor action");
    }
  }
}

/** ブラウザの本文を操作ごとの key の集合で確かめ、BFF が確かめた email と役割を actor に入れて JSON を作り直す。actor を送ってきたら拒否。 */
function kamakuraLocalizationBody(route: KamakuraLocalizationRoute, raw: Uint8Array, actor: KamakuraLocalizationActor): { readonly body: Uint8Array; readonly values: Record<string, unknown> } {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown; }
  catch { invalidLocalizationBody("JSON"); }
  if (!isRecord(parsed)) invalidLocalizationBody("body");
  const action = parsed.action;
  const commandKeys = typeof action === "string" && Object.hasOwn(KAMAKURA_LOCALIZATION_COMMAND_KEYS, action) ? KAMAKURA_LOCALIZATION_COMMAND_KEYS[action] : undefined;
  const editorCommandKeys = typeof action === "string" && Object.hasOwn(KAMAKURA_EDITOR_LOCALIZATION_COMMAND_KEYS, action) ? KAMAKURA_EDITOR_LOCALIZATION_COMMAND_KEYS[action] : undefined;
  const settingsKeys = route.operation === "settings"
    ? Object.hasOwn(parsed, "autoDraft") === Object.hasOwn(parsed, "reviewGlossaryVersion")
      ? undefined
      : ["expectedVersion", Object.hasOwn(parsed, "autoDraft") ? "autoDraft" : "reviewGlossaryVersion"]
    : undefined;
  const keys = route.operation === "command"
    ? commandKeys && ["itemKey", "operationId", "action", "unitId", "expectedVersion", "expectedSourceVersion", ...commandKeys]
    : route.operation === "editor-command"
      ? editorCommandKeys && ["action", "expectedSourceVersion", "expectedVersion", "expectedOverlayVersion", ...editorCommandKeys]
    : route.operation === "settings"
      ? settingsKeys
    : KAMAKURA_LOCALIZATION_OPERATIONS[route.operation].bodyKeys;
  if (!keys) invalidLocalizationBody(route.operation === "settings" ? "fields" : "action");
  const actual = Object.keys(parsed).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalidLocalizationBody("fields");
  const values = kamakuraLocalizationValues(route, parsed);
  const upstreamValues = route.operation === "overview" || route.operation === "settings" ? { ...values, includeGlossary: true } : values;
  return { body: new TextEncoder().encode(JSON.stringify({ ...upstreamValues, actor: { email: actor.email, role: actor.role } })), values };
}

/** ページ一覧の言語状態は UI に直接出るため、上流の余分な値を通さず確かめ直す。 */
function parseKamakuraLocalizationEditorSite(input: unknown) {
  if (!isRecord(input) || Object.keys(input).sort().join(",") !== "config,pages,status,version" || input.status !== "ready") {
    throw new DocumentValidationError("response", "unexpected editor site result");
  }
  const config = parseSiteLocalizationConfig(input.config);
  if (config.siteId !== KAMAKURA_EDITOR_SITE_ID || config.sourceLocale !== "ja" || config.enabledLocales.length !== 2
    || !config.enabledLocales.includes("ja") || !config.enabledLocales.includes("en")
    || !Array.isArray(input.pages) || input.pages.length > 500
    || typeof input.version !== "string" || !/^s\.[0-9a-f]{64}$/u.test(input.version)) {
    throw new DocumentValidationError("response", "unexpected editor site scope");
  }
  const ids = new Set<string>();
  const pages = input.pages.map((entry: unknown) => {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !["siteId", "pageId", "title", "path", "kind", "locales"].includes(key))
      || entry.siteId !== KAMAKURA_EDITOR_SITE_ID || typeof entry.pageId !== "string" || !KAMAKURA_COMMON_PAGE_ID.test(entry.pageId)
      || ids.has(entry.pageId) || !isKamakuraCmsLine(entry.title, 300)
      || entry.path !== undefined && (!isKamakuraCmsSitePath(entry.path) || entry.path.length > 160)
      || entry.kind !== undefined && !["page", "template", "shared"].includes(entry.kind as string)
      || !isRecord(entry.locales) || Object.keys(entry.locales).sort().join(",") !== "en,ja") {
      throw new DocumentValidationError("response.pages", "unexpected page");
    }
    ids.add(entry.pageId);
    const ja = entry.locales.ja, en = entry.locales.en;
    if (!isRecord(ja) || Object.keys(ja).join(",") !== "state" || ja.state !== "source"
      || !isRecord(en) || Object.keys(en).some((key) => !["state", "changed", "published"].includes(key))
      || !["missing", "translating", "review-needed", "reviewed", "failed"].includes(en.state as string)
      || en.changed !== undefined && (!Number.isSafeInteger(en.changed) || (en.changed as number) < 0 || (en.changed as number) > 2000)
      || en.published !== undefined && typeof en.published !== "boolean") {
      throw new DocumentValidationError("response.pages.locales", "unexpected locale state");
    }
    return {
      siteId: KAMAKURA_EDITOR_SITE_ID, pageId: entry.pageId, title: entry.title,
      ...(entry.path === undefined ? {} : { path: entry.path }), ...(entry.kind === undefined ? {} : { kind: entry.kind }),
      locales: { ja: { state: "source" }, en: { state: en.state, ...(en.changed === undefined ? {} : { changed: en.changed }), ...(en.published === undefined ? {} : { published: en.published }) } }
    };
  });
  return { status: "ready", config, pages, version: input.version };
}

function assertKamakuraEnglishDocumentScope(input: unknown, pageId: string | null, path: string): Record<string, unknown> {
  if (!isRecord(input) || input.schemaVersion !== 1 || input.siteId !== KAMAKURA_EDITOR_SITE_ID || typeof input.pageId !== "string"
    || (pageId === null ? !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(input.pageId) : input.pageId !== pageId)
    || input.locale !== "en"
    || !Number.isSafeInteger(input.revision) || (input.revision as number) < 1 || typeof input.title !== "string" || !Array.isArray(input.body)) {
    throw new DocumentValidationError(path, "unexpected English document scope");
  }
  return input;
}

/** snapshot の外枠と、そこに含まれる全 presentation 文書の site / locale / 版を BFF でも固定する。本文の block 契約は client adapter が catalog と組で検証する。 */
function parseKamakuraLocalizationEditorSnapshot(input: unknown, pageId: string) {
  if (!isRecord(input)) throw new DocumentValidationError("response", "expected object");
  if (input.status === "conflict") {
    if (Object.keys(input).length !== 1) throw new DocumentValidationError("response", "unexpected conflict fields");
    return { status: "conflict" as const };
  }
  if (input.status === "unavailable") {
    if (Object.keys(input).sort().join(",") !== "message,status" || !isKamakuraCmsLine(input.message, 1000)) {
      throw new DocumentValidationError("response", "unexpected unavailable result");
    }
    return { status: "unavailable" as const, message: input.message };
  }
  if (input.status !== "ready" || Object.keys(input).sort().join(",") !== "document,presentation,status,version"
    || typeof input.version !== "string" || !/^l\.[0-9a-f]{64}$/u.test(input.version)) {
    throw new DocumentValidationError("response", "unexpected snapshot fields");
  }
  const document = assertKamakuraEnglishDocumentScope(input.document, pageId, "response.document");
  const presentation = input.presentation;
  if (!isRecord(presentation) || Object.keys(presentation).some((key) => !["schemaVersion", "siteId", "locale", "version", "reset", "tokens", "layout", "fonts", "shared", "overlays", "hostViews"].includes(key))
    || presentation.schemaVersion !== 1 || presentation.siteId !== KAMAKURA_EDITOR_SITE_ID || presentation.locale !== "en"
    || !isKamakuraCmsLine(presentation.version, 256) || !isRecord(presentation.shared)
    || Object.keys(presentation.shared).sort().join(",") !== "footer,header") {
    throw new DocumentValidationError("response.presentation", "unexpected presentation scope");
  }
  assertKamakuraEnglishDocumentScope(presentation.shared.header, null, "response.presentation.shared.header");
  assertKamakuraEnglishDocumentScope(presentation.shared.footer, null, "response.presentation.shared.footer");
  if (presentation.overlays !== undefined) {
    if (!Array.isArray(presentation.overlays) || presentation.overlays.length > 8) throw new DocumentValidationError("response.presentation.overlays", "unexpected overlays");
    for (const [index, entry] of presentation.overlays.entries()) {
      if (!isRecord(entry) || !isRecord(entry.document)) throw new DocumentValidationError(`response.presentation.overlays[${index}]`, "unexpected overlay");
      assertKamakuraEnglishDocumentScope(entry.document, null, `response.presentation.overlays[${index}].document`);
    }
  }
  if (presentation.hostViews !== undefined) {
    if (!Array.isArray(presentation.hostViews) || presentation.hostViews.length > 64) throw new DocumentValidationError("response.presentation.hostViews", "unexpected host views");
    for (const [index, entry] of presentation.hostViews.entries()) {
      if (!isRecord(entry) || !isRecord(entry.document)) throw new DocumentValidationError(`response.presentation.hostViews[${index}]`, "unexpected host view");
      assertKamakuraEnglishDocumentScope(entry.document, null, `response.presentation.hostViews[${index}].document`);
    }
  }
  return { status: "ready" as const, document, version: input.version, presentation };
}

/**
 * 上流の契約の結果（本文 `{ status, … }`）を W1 の parser で確かめ、既知の field だけにする。
 * forbidden は 403・not_found は 404・ほかは 200 で返る約束なので、HTTP の status と合わなければ契約違反。
 */
function kamakuraLocalizationResult(route: KamakuraLocalizationRoute, request: Record<string, unknown>, value: unknown, httpStatus: number): { readonly status: string } {
  const parse = (): { readonly status: string; readonly sourceDocument?: unknown; readonly sourceVersion?: string; readonly overlay?: unknown; readonly document?: unknown; readonly presentation?: unknown; readonly version?: string; readonly revision?: number; readonly message?: string } => {
    switch (route.operation) {
      case "overview": {
        const result = parseLocalizationOverviewResult(value);
        // プレビューの枠は鎌倉の Worker のものだけ（CSP の frame-src に足すのもその origin だけ）
        if (result.status === "ready" && result.overview.preview !== null && !isKamakuraLocalizationPreviewFrame(result.overview.preview.frameUrl)) {
          throw new DocumentValidationError("overview.preview.frameUrl", "unexpected preview frame");
        }
        return result;
      }
      case "list": case "list-after": return parseLocalizationListResult(value);
      case "item": return parseLocalizationItemResult(value, route.itemKey!);
      case "command": return parseLocalizationCommandResult(value, { itemKey: route.itemKey!, unitId: request.unitId as string });
      case "translate": return parseLocalizationTranslationResult(value);
      case "job": return parseLocalizationJobResult(value, route.jobId!);
      case "catalog": return parseLocalizationCatalogResult(value);
      case "preview": return parseLocalizationPreviewResult(value);
      case "release": return parseLocaleReleaseStateResult(value);
      case "prepare": return parseLocaleReleasePrepareResult(value, request as unknown as LocaleReleasePrepareInput);
      case "apply": return parseLocaleReleaseApplyResult(value, { prepared: null });
      case "settings": return parseLocalizationSettingsResult(value);
      case "upload-intent": return parseKamakuraLocalizationUploadRefusal(value);
      case "editor-site": {
        if (isRecord(value) && (value.status === "forbidden" || value.status === "not_found") && Object.keys(value).length === 1) return { status: value.status };
        return parseKamakuraLocalizationEditorSite(value);
      }
      case "editor-page": {
        if (!isRecord(value)) throw new DocumentValidationError("response", "expected object");
        if (value.status === "forbidden" || value.status === "not_found") {
          if (Object.keys(value).length !== 1) throw new DocumentValidationError("response", "unexpected fields");
          return { status: value.status };
        }
        if (value.status !== "ready" || Object.keys(value).sort().join(",") !== "overlay,sourceDocument,sourceVersion,status,version") {
          throw new DocumentValidationError("response", "unexpected fields");
        }
        const document = value.sourceDocument;
        if (!isRecord(document) || document.schemaVersion !== 1 || document.siteId !== KAMAKURA_EDITOR_SITE_ID || document.pageId !== route.pageId
          || (document.locale !== "ja" && document.locale !== "ja-JP") || !Number.isSafeInteger(document.revision) || (document.revision as number) < 1
          || !Array.isArray(document.body) || typeof document.title !== "string") {
          throw new DocumentValidationError("response.sourceDocument", "unexpected page scope");
        }
        const overlay = parseLocalizationOverlay(value.overlay);
        if (overlay.siteId !== KAMAKURA_EDITOR_SITE_ID || overlay.pageId !== route.pageId || overlay.sourceLocale !== "ja" || overlay.targetLocale !== "en"
          || typeof value.sourceVersion !== "string" || !/^p\.[0-9a-f]{64}$/u.test(value.sourceVersion)
          || typeof value.version !== "string" || !/^l\.[0-9a-f]{64}$/u.test(value.version)) {
          throw new DocumentValidationError("response", "unexpected localization scope");
        }
        return { status: "ready", sourceDocument: document, sourceVersion: value.sourceVersion, overlay, version: value.version };
      }
      case "editor-snapshot": return parseKamakuraLocalizationEditorSnapshot(value, route.pageId!);
      case "editor-save": case "editor-command": {
        if (!isRecord(value)) throw new DocumentValidationError("response", "expected object");
        if (value.status === "forbidden" || value.status === "not_found" || value.status === "conflict") {
          if (Object.keys(value).length !== 1) throw new DocumentValidationError("response", "unexpected fields");
          return { status: value.status };
        }
        if (value.status === "invalid") {
          if (Object.keys(value).sort().join(",") !== "message,status" || !isKamakuraCmsLine(value.message, 1000)) throw new DocumentValidationError("response", "unexpected invalid result");
          return { status: "invalid", message: value.message };
        }
        if (typeof value.version !== "string" || !/^l\.[0-9a-f]{64}$/u.test(value.version)) throw new DocumentValidationError("response.version", "unexpected version");
        if (route.operation === "editor-save" && value.status === "saved" && Object.keys(value).sort().join(",") === "revision,status,version"
          && Number.isSafeInteger(value.revision) && (value.revision as number) > 0) return { status: "saved", version: value.version, revision: value.revision as number };
        if (route.operation === "editor-command" && value.status === "applied" && Object.keys(value).sort().join(",") === "status,version") return { status: "applied", version: value.version };
        throw new DocumentValidationError("response", "unexpected editor result");
      }
    }
  };
  const result = parse();
  const expected = result.status === "forbidden" ? 403 : result.status === "not_found" ? 404 : 200;
  if (httpStatus !== expected) throw new DocumentValidationError("response.status", "status does not match the HTTP status");
  return result;
}

function isJsonResponse(response: Response): boolean {
  return response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

/**
 * プレビューの材料（1 回 2 MiB まで）は確かめずに上限つきでそのまま流す（ブラウザの adapter と画面が W1 の parser で確かめる）。
 * 上限を超えたら途中で切る（ブラウザは JSON を読めず、失敗として扱う）。
 */
function boundedJsonStream(response: Response, maximumBytes: number, failure: (category: KamakuraBridgeFailureCategory, status?: number) => KamakuraBridgeFailureError, onEnd: () => void, controller: AbortController): Response {
  const declared = response.headers.get("Content-Length");
  if (!isJsonResponse(response) || !response.body || (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes))) {
    void response.body?.cancel().catch(() => undefined);
    throw failure("upstream_invalid_response", response.status);
  }
  const reader = response.body.getReader();
  let total = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        const chunk = await reader.read();
        if (chunk.done) { streamController.close(); onEnd(); return; }
        total += chunk.value.byteLength;
        if (total > maximumBytes) {
          logKamakuraBridgeFailure(failure("upstream_invalid_response", response.status));
          await reader.cancel("response too large").catch(() => undefined);
          streamController.error(new Error("response too large"));
          onEnd();
          return;
        }
        streamController.enqueue(chunk.value);
      } catch (error) { streamController.error(error); onEnd(); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { controller.abort(); onEnd(); } }
  });
  return new Response(stream, { status: 200, headers: securityHeaders("application/json; charset=utf-8") });
}

async function signedKamakuraLocalizationRequest(request: Request, env: Env, identity: AccessIdentity, role: Role, route: KamakuraLocalizationRoute): Promise<Response> {
  const supportId = crypto.randomUUID();
  const spec = KAMAKURA_LOCALIZATION_OPERATIONS[route.operation];
  const operation = spec.log, method = spec.method;
  const raw = await readBoundedBody(request, ["command", "editor-save", "editor-command"].includes(route.operation)
    ? KAMAKURA_LOCALIZATION_LIMITS.commandBodyBytes : KAMAKURA_LOCALIZATION_LIMITS.bodyBytes);
  const { body, values } = kamakuraLocalizationBody(route, raw, { email: identity.email, role });
  const headers = await kamakuraSignedHeaders(env, identity, method, route.upstreamPath, body, supportId, operation);
  const failure = (category: KamakuraBridgeFailureCategory, status?: number) => kamakuraBridgeFailure(supportId, operation, category, status);
  const controller = new AbortController();
  let timedOut = false, streaming = false;
  const abortForRequest = () => controller.abort();
  const abortForTimeout = () => { timedOut = true; controller.abort(); };
  request.signal.addEventListener("abort", abortForRequest, { once: true });
  const timeout = setTimeout(abortForTimeout, spec.long ? KAMAKURA_RELEASE_TIMEOUT_MILLISECONDS : EDITOR_TIMEOUT_MILLISECONDS);
  const cleanup = () => { clearTimeout(timeout); request.signal.removeEventListener("abort", abortForRequest); };
  const read = async (response: Response, limit: number): Promise<unknown> => {
    try { return await readBoundedResponse(response, limit); }
    catch { throw failure(timedOut ? "service_binding_timeout" : "upstream_invalid_response", response.status); }
  };
  const checked = (status: number, parse: () => unknown): Response => {
    try { return json(parse(), status); }
    catch (error) { throw failure(error instanceof DocumentValidationError ? "upstream_contract_invalid" : "bridge_processing_failed", status); }
  };
  const discard = async (response: Response) => { try { await response.body?.cancel(); } catch { /* 本文は使わない */ } };
  try {
    const upstream = new Request(`${KAMAKURA_EDITOR_UPSTREAM_ORIGIN}${route.upstreamPath}`, {
      method, cache: "no-store", redirect: "manual", signal: controller.signal, headers, body: body.slice().buffer
    });
    let response: Response;
    try { response = await env.KAMAKURA_SITE.fetch(upstream); }
    catch { throw failure(timedOut ? "service_binding_timeout" : "service_binding_failed"); }
    const status = response.status;
    if (status >= 300 && status < 400) throw failure("upstream_redirect_rejected", status);
    if (status === 401) throw failure("upstream_auth_rejected", status);
    if (status === 429) throw failure("upstream_rate_limited", status);
    if (status >= 500) throw failure("upstream_server_error", status);
    if (status === 200 && route.operation === "preview") {
      const streamed = boundedJsonStream(response, KAMAKURA_LOCALIZATION_LIMITS.previewResponseBytes, failure, cleanup, controller);
      streaming = true;
      return streamed;
    }
    if (status === 201 && route.operation === "upload-intent") {
      const value = await read(response, KAMAKURA_LOCALIZATION_LIMITS.bodyBytes);
      return checked(201, () => parseKamakuraLocalizationUploadIntent(value));
    }
    if (status === 200 || status === 403 || status === 404) {
      // 契約の結果は本文に status がある。経路の誤り（{ error }）や JSON でない 404 は契約の結果ではない
      const limit = route.operation === "upload-intent" ? KAMAKURA_LOCALIZATION_LIMITS.bodyBytes : KAMAKURA_LOCALIZATION_LIMITS.responseBytes;
      let value: unknown = null;
      if (status !== 404 || isJsonResponse(response)) value = await read(response, limit);
      else await discard(response);
      if (isRecord(value) && Object.hasOwn(value, "status")) return checked(status, () => kamakuraLocalizationResult(route, values, value, status));
      if (status === 404) {
        // 概要は画面が最初に読む。ここが経路ごと無いのは、鎌倉の Worker の翻訳の API がまだ配備されていない
        if (route.operation === "overview") throw failure("localization_endpoint_missing", status);
        return json({ error: "not_found" }, 404);
      }
      throw failure(status === 403 ? "upstream_auth_rejected" : "upstream_contract_invalid", status);
    }
    if (status === 409) { await discard(response); return json({ error: "conflict" }, 409); }
    if ((status === 413 || status === 415) && route.operation === "upload-intent") { await discard(response); return json({ error: "image_rejected" }, status); }
    if (status === 400 || status === 413 || status === 415) { await discard(response); return json({ error: "invalid_request" }, 400); }
    await discard(response);
    throw failure(status >= 200 && status < 300 ? "upstream_contract_invalid" : "upstream_unexpected_4xx", status);
  } catch (error) {
    if (error instanceof KamakuraBridgeFailureError) throw error;
    throw failure("bridge_processing_failed");
  } finally { if (!streaming) cleanup(); }
}

/**
 * `/api/projects/project-kamakura/sites/kamakura/localization/*`。鎌倉以外は 404。要求ごとに D1 の owner / editor を確かめ、
 * その役割を actor の role として上流へ渡す（できる操作は鎌倉の Worker が役割から決め、書き込みでも確かめる）。
 */
async function kamakuraLocalizationApi(request: Request, env: Env, identity: AccessIdentity, url: URL, projectId: string, siteId: string, action: string): Promise<Response> {
  if (projectId !== KAMAKURA_EDITOR_PROJECT_ID || siteId !== KAMAKURA_EDITOR_SITE_ID) return json({ error: "not_found" }, 404);
  if (url.href.includes("?")) return json({ error: "invalid_request" }, 400);
  const route = kamakuraLocalizationRoute(action, request.method);
  if (route === null) return json({ error: "not_found" }, 404);
  if (route === "method_not_allowed") return json({ error: "method_not_allowed" }, 405);
  const role = await editorRole(env, identity, projectId, siteId);
  if (!role) return json({ error: "forbidden" }, 403);
  try { return await signedKamakuraLocalizationRequest(request, env, identity, role, route); }
  catch (error) {
    if (error instanceof AuthenticationError) return json({ error: "invalid_request" }, 400);
    throw error;
  }
}

type WorkerEditorAdapter = {
  readonly route: (action: string, method: string, environment: string) => EditorRoute | "method_not_allowed" | null;
  readonly authorize: (env: Env, identity: AccessIdentity, resolved: ResolvedTrustedIntegration) => Promise<boolean>;
  readonly dispatch: (request: Request, env: Env, identity: AccessIdentity, route: EditorRoute, resolved: ResolvedTrustedIntegration) => Promise<Response>;
  readonly assetPreview?: (action: string) => string | null;
  readonly dispatchAssetPreview?: (request: Request, env: Env, identity: AccessIdentity, assetId: string) => Promise<Response>;
  readonly connectOrigins?: readonly string[];
  readonly fontSources?: readonly string[];
  readonly scriptSources?: readonly string[];
  readonly frameSources?: readonly string[];
};

// Kamakura は凍結中も読み取りを通す（kamakura-site#84）。保存・公開を止めるのは kamakura-site で、
// ページ文書の readOnly と 409 visual_editor_frozen を画面がそのまま案内する。凍結の切り替えはサイト側の 1 か所。
const KAMAKURA_EDITOR_ADAPTER: WorkerEditorAdapter = {
  route: (action, method) => kamakuraEditorRoute(action, method),
  authorize: (env, identity, resolved) => editorMember(env, identity, resolved.registration.projectId, resolved.registration.siteId),
  dispatch: (request, env, identity, route) => signedKamakuraEditorRequest(request, env, identity, route),
  assetPreview: (action) => /^\/editor\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/preview$/iu.exec(action)?.[1] ?? null,
  dispatchAssetPreview: signedKamakuraAssetPreview,
  connectOrigins: [KAMAKURA_EDITOR_UPSTREAM_ORIGIN],
  fontSources: [`${KAMAKURA_MEDIA_ORIGIN}/niho-web/fonts/v1/`],
  scriptSources: ["https://platform.twitter.com/widgets.js", "https://www.instagram.com/embed.js"],
  frameSources: [`${KAMAKURA_MEDIA_ORIGIN}/niho-web/embeds/v1/`, "https://www.google.com/maps/embed", "https://www.youtube-nocookie.com/embed/", "https://player.vimeo.com/video/", "https://lottie.host/embed/", "https://www.facebook.com/plugins/post.php", "https://platform.twitter.com", "https://www.instagram.com"]
};

function liveEditorAdapter(resolved: ResolvedTrustedIntegration): WorkerEditorAdapter | null {
  return resolved.environment === "production" && integrationIdentity(resolved.registration.projectId, resolved.registration.siteId) === integrationIdentity(KAMAKURA_EDITOR_PROJECT_ID, KAMAKURA_EDITOR_SITE_ID)
    ? KAMAKURA_EDITOR_ADAPTER
    : null;
}

function workerEditorAdapter(resolved: ResolvedTrustedIntegration): WorkerEditorAdapter | null {
  const frozenAdapters: ReadonlyMap<string, WorkerEditorAdapter> = new Map([
  [integrationIdentity(EDITOR_PROJECT_ID, EDITOR_SITE_ID), {
    route: (action, method, environment) => experienceEditorRoute(action, method, environment === "staging"),
    authorize: (env, identity, resolved) => resolved.environment === "staging"
      ? experienceEditorOwner(env, identity)
      : editorMember(env, identity, resolved.registration.projectId, resolved.registration.siteId),
    dispatch: (request, env, identity, route, resolved) => resolved.environment === "staging"
      ? signedEditorRequest(request, identity, route, { origin: EDITOR_STAGING_UPSTREAM_ORIGIN, secret: env.NIHO_STUDIO_BRIDGE_SECRET_STG })
      : signedEditorRequest(request, identity, route, { origin: EDITOR_UPSTREAM_ORIGIN, secret: env.NIHO_STUDIO_BRIDGE_SECRET })
  }],
  [integrationIdentity(KAMAKURA_EDITOR_PROJECT_ID, KAMAKURA_EDITOR_SITE_ID), KAMAKURA_EDITOR_ADAPTER]
  ]);
  return frozenAdapters.get(integrationIdentity(resolved.registration.projectId, resolved.registration.siteId)) ?? null;
}
// Retain the Experience adapter as frozen source only. No active route invokes
// it while the Experience visual editor is frozen.
if (false) void workerEditorAdapter;

async function liveEditorApi(request: Request, env: Env, identity: AccessIdentity, action: string, resolved: ResolvedTrustedIntegration, adapter: WorkerEditorAdapter): Promise<Response> {
  const assetId = adapter.assetPreview?.(action) ?? null;
  if (assetId && adapter.dispatchAssetPreview) {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    if (!await adapter.authorize(env, identity, resolved)) return json({ error: "forbidden" }, 403);
    try { return await adapter.dispatchAssetPreview(request, env, identity, assetId); }
    catch (error) {
      if (error instanceof AuthenticationError) return json({ error: "invalid_request" }, 400);
      throw error;
    }
  }
  const route = adapter.route(action, request.method, resolved.environment);
  if (route === null) return json({ error: "not_found" }, 404);
  if (route === "method_not_allowed") return json({ error: "method_not_allowed" }, 405);
  if (!await adapter.authorize(env, identity, resolved)) return json({ error: "forbidden" }, 403);
  try { return await adapter.dispatch(request, env, identity, route, resolved); }
  catch (error) {
    if (error instanceof AuthenticationError) return json({ error: "invalid_request" }, 400);
    throw error;
  }
}

async function editorApi(request: Request, env: Env, identity: AccessIdentity, url: URL, projectId: string, siteId: string, action: string): Promise<Response> {
  if (url.href.includes("?")) return json({ error: "invalid_request" }, 400);
  const resolved = resolveTrustedEditorApi(projectId, siteId, action);
  if (!resolved) return json({ error: "not_found" }, 404);
  const adapter = liveEditorAdapter(resolved);
  if (adapter) return liveEditorApi(request, env, identity, action, resolved, adapter);
  const authorized = resolved.environment === "staging"
    ? resolved.registration.projectId === EDITOR_PROJECT_ID && resolved.registration.siteId === EDITOR_SITE_ID && await experienceEditorOwner(env, identity)
    : await editorMember(env, identity, resolved.registration.projectId, resolved.registration.siteId);
  if (!authorized) return json({ error: "forbidden" }, 403);
  return json({ error: "visual_editor_frozen", message: "Site layout and styling are maintained in code." }, 409);
}

function withStaticSecurity(response: Response, editor = false, connectOrigins: readonly string[] = [], fontSources: readonly string[] = [], scriptSources: readonly string[] = [], frameSources: readonly string[] = []): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  const connectSrc = `connect-src 'self'${connectOrigins.map((origin) => ` ${origin}`).join("")};`;
  // editor は自分のプレビュー枠（'self'）と接続先、Dashboard はサイト側の管理画面の origin だけを枠に許す
  const frames = editor ? ["'self'", ...frameSources] : frameSources;
  headers.set("Content-Security-Policy", `default-src 'none'; script-src 'self'${scriptSources.map((source) => ` ${source}`).join("")}; style-src 'self'` + (editor ? " 'unsafe-inline'" : "") + "; img-src 'self' https:; " + connectSrc + ` font-src 'self'${fontSources.map((source) => ` ${source}`).join("")};` + (frames.length ? ` frame-src ${frames.join(" ")};` : "") + " frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function scopedApi(request: Request, env: Env, identity: AccessIdentity, url: URL): Promise<Response | null> {
  const match = /^\/api\/projects\/([A-Za-z][A-Za-z0-9_-]{0,79})\/sites\/([A-Za-z][A-Za-z0-9_-]{0,79})(\/[^?]*)?$/u.exec(url.pathname);
  if (!match) return null;
  const projectId = match[1]!;
  const siteId = match[2]!;
  const action = match[3] ?? "";
  if (action === "/cms" || action.startsWith("/cms/")) return kamakuraCmsApi(request, env, identity, url, projectId, siteId, action.slice("/cms".length));
  if (action === "/localization" || action.startsWith("/localization/")) return kamakuraLocalizationApi(request, env, identity, url, projectId, siteId, action.slice("/localization".length));
  if (isTrustedEditorAction(action)) return editorApi(request, env, identity, url, projectId, siteId, action);
  if (request.method === "GET") {
    if (action === "/dashboard") return dashboard(env, identity, projectId, siteId);
    if (action === "/membership") return membershipAdministration(env, identity, projectId, siteId);
    if (action === "/site-admin") return siteAdminApi(env, identity, projectId, siteId);
    return json({ error: "not_found" }, 404);
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: Record<string, unknown>;
  try { body = await enforceMutationBoundary(request); }
  catch { return json({ error: "invalid_request" }, 400); }
  try {
    if (action === "/invitations") return await createInvitation(request, env, identity, projectId, siteId, body);
    if (action === "/invitations/preview") return await invitationPreview(env, identity, projectId, siteId, body);
    if (action === "/invitations/accept") return await acceptInvitation(env, identity, projectId, siteId, body);
    if (action === "/invitations/revoke") return await revokeInvitation(env, identity, projectId, siteId, body);
    if (action === "/members/role") return await changeMemberRole(env, identity, projectId, siteId, body);
    if (action === "/members/remove") return await removeMember(env, identity, projectId, siteId, body);
  } catch (error) {
    if (error instanceof InvalidInputError) return json({ error: "invalid_request" }, 400);
    throw error;
  }
  return json({ error: "not_found" }, 404);
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
  let identity: AccessIdentity;
  try { identity = await authenticate(request, env); }
  catch (error) {
    if (!(error instanceof AuthenticationError)) throw error;
    return isApi ? json({ error: "session_expired" }, 401) : htmlError("セッションを確認できません。Cloudflare Access から再度ログインしてください。", 401);
  }

  if (isApi) {
    if (request.method === "GET" && url.pathname === "/api/session") return json({ status: "authenticated", subject: identity.subject, email: identity.email });
    if (request.method === "GET" && url.pathname === "/api/projects") return directory(env, identity);
    const scoped = await scopedApi(request, env, identity, url);
    if (scoped) return scoped;
    return json({ error: request.method === "GET" ? "not_found" : "method_not_allowed" }, request.method === "GET" ? 404 : 405);
  }

  if (request.method !== "GET" && request.method !== "HEAD") return htmlError("この操作は利用できません。", 405);
  const shortcut = projectShortcutTarget(url.pathname);
  if (shortcut) {
    const headers = securityHeaders("text/plain; charset=utf-8");
    headers.set("Location", shortcut);
    return new Response(null, { status: 301, headers });
  }
  const projectAlias = parseProjectAliasPath(url.pathname);
  const editorPage = resolveTrustedEditorPage(url.pathname);
  const isEditor = editorPage !== null;
  const pageAdapter = editorPage ? liveEditorAdapter(editorPage) : null;
  const dashboardPage = /^\/projects\/([A-Za-z][A-Za-z0-9_-]{0,79})\/sites\/([A-Za-z][A-Za-z0-9_-]{0,79})\/?$/u.exec(url.pathname);
  if (url.pathname === "/" || dashboardPage || /^\/projects\/[A-Za-z][A-Za-z0-9_-]{0,79}\/sites\/[A-Za-z][A-Za-z0-9_-]{0,79}\/invite\/?$/u.test(url.pathname) || isEditor || projectAlias !== null) {
    if (editorPage?.environment === "staging" && !await experienceEditorOwner(env, identity)) return htmlError("このページを表示できません。", 403);
    const indexUrl = new URL(typeof __STUDIO_INDEX_PATH__ === "string" ? __STUDIO_INDEX_PATH__ : "/index.html", url);
    // Dashboard（ID の URL と alias の URL）は、そのサイトの管理画面を枠で開ける。editor は従来どおり
    const dashboardTarget = isEditor ? null : projectAlias ?? (dashboardPage ? { projectId: dashboardPage[1]!, siteId: dashboardPage[2]! } : null);
    const admin = dashboardTarget ? siteAdmin(env as unknown as Record<string, unknown>, dashboardTarget.projectId, dashboardTarget.siteId) : null;
    // サイト側にまだ Access の cookie が無いと、枠は Access のチームのドメインを経由して戻る（Studio にログイン済みならログイン画面は出ない）。
    // その経由先も枠に許す。ログイン画面そのものは Access が枠を拒むので、画面の「別のタブで開く」で入る（翻訳は CMS の切替の後も枠）
    const adminFrames = admin ? [admin.origin, new URL(env.ACCESS_ISSUER).origin] : [];
    const kamakuraDashboard = dashboardTarget?.projectId === KAMAKURA_CMS_PROJECT_ID && dashboardTarget.siteId === KAMAKURA_CMS_SITE_ID;
    // CMS をコレクション画面で開くときだけ、画像本体を直接 PUT する鎌倉の Worker へ接続を許す（本文・縮小の画像は img-src の https: で足りる）
    const cmsConnect = admin?.cmsView === "workspace" && kamakuraDashboard ? [KAMAKURA_CMS_UPLOAD_ORIGIN] : [];
    // 翻訳を翻訳の画面で開くときだけ、訳す言語の画像の直接 PUT 先への接続と、鎌倉の Worker のプレビューの枠を許す
    const translations = admin?.translationsView === "workspace" && kamakuraDashboard;
    const dashboardConnect = [...new Set([...cmsConnect, ...(translations ? [KAMAKURA_LOCALIZATION_UPLOAD_ORIGIN] : [])])];
    const dashboardFrames = [...new Set([...adminFrames, ...(translations ? [KAMAKURA_LOCALIZATION_PREVIEW_ORIGIN] : [])])];
    return withStaticSecurity(await env.ASSETS.fetch(new Request(indexUrl, { method: request.method, headers: request.headers })), pageAdapter !== null, pageAdapter ? pageAdapter.connectOrigins ?? [] : dashboardConnect, pageAdapter?.fontSources ?? [], pageAdapter?.scriptSources ?? [], pageAdapter ? pageAdapter.frameSources ?? [] : dashboardFrames);
  }
  return withStaticSecurity(await env.ASSETS.fetch(request));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return await handle(request, env); }
    catch (error) {
      if (error instanceof KamakuraBridgeFailureError) {
        logKamakuraBridgeFailure(error);
        return json({ error: error.code, supportId: error.supportId }, error.httpStatus);
      }
      console.error("NIHO Studio request failed", error instanceof Error ? error.name : "UnknownError");
      if (error instanceof KamakuraCatalogContractError) return json({ error: KAMAKURA_CATALOG_CONTRACT_ERROR_CODE }, KAMAKURA_CATALOG_CONTRACT_ERROR_STATUS);
      return new URL(request.url).pathname.startsWith("/api/") ? json({ error: "service_unavailable" }, 503) : htmlError("一時的に利用できません。時間をおいて再度お試しください。", 503);
    }
  }
};
