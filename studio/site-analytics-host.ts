import { parseSiteAnalyticsSnapshot } from "../src/analytics-parse.js";
import type { AnalyticsPeriod, Ga4Report, ReportWindow, SearchConsoleReport, SiteAnalyticsSnapshot, SourceResult } from "../src/analytics-types.js";
import { parseSiteAnalyticsChangePlan, parseSiteAnalyticsConnection, type SiteAnalyticsChangeAction, type SiteAnalyticsConnection, type SiteAnalyticsTarget } from "../src/site-analytics.js";
import { isSafeHttpsOrigin } from "../src/validation-utils.js";
import {
  GoogleAnalyticsClient, GoogleApiError, type Ga4WebStream, detectTrackingTag, ga4Window, loadGa4Report, loadSearchConsoleReport, loadServiceAccount,
  logAnalyticsFailure, searchConsoleWindow, zoneOffset
} from "./google-analytics.js";
import { publicSitesOrigin } from "./managed-sites.js";

/**
 * Studio をプロジェクトごとの GA4 / Search Console 分析のホストにする API（/api/projects/:projectId/sites/:siteId/analytics/...）。
 * 他社のデータを混ぜないため、対象 origin は必ず D1 の sites.public_origin から組み立て、リクエスト由来の origin を信用しない。
 * 共有 origin + path で配信する Studio-native site と、公開 origin の無いサイトは未対応。
 */

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

export type SiteAnalyticsEnv = {
  readonly DB: D1Database;
  /** Studio 専用サービスアカウントの JSON 鍵。scope は analytics.readonly と webmasters.readonly だけを使う。 */
  readonly STUDIO_ANALYTICS_GOOGLE_SA_JSON?: string;
  readonly PUBLIC_SITES_ORIGIN?: string;
};
export type SiteAnalyticsActor = { readonly subject: string };
export type SiteAnalyticsResult = { readonly status: number; readonly body: unknown };

type Role = "owner" | "editor";
type Source = "ga4" | "search-console";
type Step = "prepare" | "apply" | "verify" | "retry" | "disconnect-prepare" | "disconnect-apply";
export type SiteAnalyticsRoute =
  | { readonly method: "GET"; readonly operation: "report" | "connection" }
  | { readonly method: "POST"; readonly operation: "mutation"; readonly source: Source; readonly step: Step }
  | { readonly method: "POST"; readonly operation: "unsupported" };

const PERIODS: readonly AnalyticsPeriod[] = ["7d", "28d", "3m", "12m"];
const PLAN_SECONDS = 120;
const CACHE_SECONDS = 30 * 60;
const GSC_ALLOWED_PERMISSIONS = new Set(["siteOwner", "siteFullUser", "siteRestrictedUser"]);
const REPORTING_STATES = new Set(["not-connected", "checking", "connected", "permission-required", "property-mismatch", "permission-revoked", "syncing", "sync-delayed", "quota-limited", "partial", "failed"]);
const TAG_STATES = new Set(["not-configured", "pending", "published", "failed"]);
const OWNERSHIP_STATES = new Set(["not-verified", "pending", "verified", "failed"]);
const UNSUPPORTED_PATHS = new Set([
  "/ga4/tag/prepare", "/ga4/tag/apply", "/ga4/tag/remove/prepare", "/ga4/tag/remove/apply",
  "/search-console/ownership/prepare", "/search-console/ownership/apply", "/search-console/ownership/verify"
]);
const STEPS: Readonly<Record<string, Step>> = {
  "/prepare": "prepare", "/apply": "apply", "/verify": "verify", "/retry": "retry",
  "/disconnect/prepare": "disconnect-prepare", "/disconnect/apply": "disconnect-apply"
};

/** analytics 以下の path（"/report" など）を、許可した method と操作に対応させる。 */
export function siteAnalyticsRoute(method: string, path: string): SiteAnalyticsRoute | "not_found" | "method_not_allowed" {
  if (path === "/report" || path === "/connection") return method === "GET" ? { method: "GET", operation: path === "/report" ? "report" : "connection" } : "method_not_allowed";
  if (UNSUPPORTED_PATHS.has(path)) return method === "POST" ? { method: "POST", operation: "unsupported" } : "method_not_allowed";
  const match = /^\/(ga4|search-console)\/reporting(\/.+)$/u.exec(path);
  const step = match ? STEPS[match[2]!] : undefined;
  if (!match || !step) return "not_found";
  return method === "POST" ? { method: "POST", operation: "mutation", source: match[1] === "ga4" ? "ga4" : "search-console", step } : "method_not_allowed";
}

type ConnectionRow = {
  readonly version: number;
  readonly ga4_property_id: string | null;
  readonly ga4_stream_id: string | null;
  readonly ga4_stream_origin: string | null;
  readonly ga4_measurement_id: string | null;
  readonly ga4_time_zone: string | null;
  readonly ga4_reporting_state: string;
  readonly ga4_tracking_tag_state: string;
  readonly ga4_last_synced_at: number | null;
  readonly gsc_property_kind: string | null;
  readonly gsc_property_value: string | null;
  readonly gsc_reporting_state: string;
  readonly gsc_ownership_state: string;
  readonly gsc_last_synced_at: number | null;
};
type SiteContext = {
  readonly projectId: string;
  readonly siteId: string;
  readonly role: Role;
  /** 分析に使える公開 origin（D1 sites.public_origin と完全一致）。未対応サイトは null。 */
  readonly origin: string | null;
  /** 接続画面の対象として返す origin。managed site は共有 origin、公開 origin の無いサイトは null。 */
  readonly targetOrigin: string | null;
  readonly connection: ConnectionRow | null;
};

const CONNECTION_COLUMNS = `c.version, c.ga4_property_id, c.ga4_stream_id, c.ga4_stream_origin, c.ga4_measurement_id, c.ga4_time_zone,
       c.ga4_reporting_state, c.ga4_tracking_tag_state, c.ga4_last_synced_at,
       c.gsc_property_kind, c.gsc_property_value, c.gsc_reporting_state, c.gsc_ownership_state, c.gsc_last_synced_at`;

function connectionFrom(row: Record<string, unknown> | null): ConnectionRow | null {
  if (!row || row.version === null || row.version === undefined) return null;
  const text = (value: unknown, maximum = 2048) => value === null ? null : typeof value === "string" && value.length <= maximum ? value : invalidStored();
  const time = (value: unknown) => value === null ? null : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : invalidStored();
  const state = (value: unknown, allowed: ReadonlySet<string>) => typeof value === "string" && allowed.has(value) ? value : invalidStored();
  if (typeof row.version !== "number" || !Number.isSafeInteger(row.version) || row.version < 1) return invalidStored();
  return {
    version: row.version,
    ga4_property_id: text(row.ga4_property_id, 20), ga4_stream_id: text(row.ga4_stream_id, 20), ga4_stream_origin: text(row.ga4_stream_origin),
    ga4_measurement_id: text(row.ga4_measurement_id, 26), ga4_time_zone: text(row.ga4_time_zone, 80),
    ga4_reporting_state: state(row.ga4_reporting_state, REPORTING_STATES), ga4_tracking_tag_state: state(row.ga4_tracking_tag_state, TAG_STATES),
    ga4_last_synced_at: time(row.ga4_last_synced_at),
    gsc_property_kind: text(row.gsc_property_kind, 20), gsc_property_value: text(row.gsc_property_value),
    gsc_reporting_state: state(row.gsc_reporting_state, REPORTING_STATES), gsc_ownership_state: state(row.gsc_ownership_state, OWNERSHIP_STATES),
    gsc_last_synced_at: time(row.gsc_last_synced_at)
  };
}
function invalidStored(): never { throw new Error("invalid stored site analytics connection"); }

/** 分析に使える origin。D1 の値だけを使い、共有 origin・managed site・path 付き・https 以外は未対応。 */
function analyticsOrigin(publicOrigin: unknown, managed: boolean, sharedOrigin: string | null): string | null {
  if (managed || typeof publicOrigin !== "string" || !isSafeHttpsOrigin(publicOrigin)) return null;
  if (sharedOrigin !== null && publicOrigin === sharedOrigin) return null;
  return publicOrigin;
}

async function siteContext(env: SiteAnalyticsEnv, actor: SiteAnalyticsActor, projectId: string, siteId: string): Promise<SiteContext | null> {
  const row = await env.DB.prepare(`
    SELECT m.role AS role, s.public_origin AS public_origin,
           EXISTS (SELECT 1 FROM managed_sites AS ms WHERE ms.site_id = s.id) AS managed,
           ${CONNECTION_COLUMNS}
      FROM project_members AS m
      JOIN sites AS s ON s.project_id = m.project_id
      LEFT JOIN site_analytics_connections AS c ON c.site_id = s.id
     WHERE m.access_subject = ?1 AND m.project_id = ?2 AND s.id = ?3
       AND m.role IN ('owner', 'editor')
     LIMIT 1
  `).bind(actor.subject, projectId, siteId).first<Record<string, unknown>>();
  const role = row?.role;
  if (!row || (role !== "owner" && role !== "editor")) return null;
  const managed = row.managed === 1 || row.managed === true;
  const sharedOrigin = publicSitesOrigin(env.PUBLIC_SITES_ORIGIN);
  const origin = analyticsOrigin(row.public_origin, managed, sharedOrigin);
  const targetOrigin = origin ?? (managed ? sharedOrigin : null);
  return { projectId, siteId, role, origin, targetOrigin, connection: connectionFrom(row) };
}

const ok = (body: unknown, status = 200): SiteAnalyticsResult => ({ status, body });
const failure = (error: string, status: number): SiteAnalyticsResult => ({ status, body: { error } });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function changed(result: D1Result<unknown> | undefined): boolean {
  return result?.success === true && result.meta?.changes === 1;
}
function isoSeconds(value: number | null): string | null {
  return value === null ? null : new Date(value * 1000).toISOString();
}
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}
async function tokenHash(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---- 入口 ----

export async function siteAnalyticsApi(
  env: SiteAnalyticsEnv, actor: SiteAnalyticsActor, projectId: string, siteId: string, route: SiteAnalyticsRoute,
  input: { readonly query: URLSearchParams; readonly body: Record<string, unknown> | null }, now = Date.now()
): Promise<SiteAnalyticsResult> {
  // 毎リクエストで D1 の membership を確かめる（owner / editor 以外は何も返さない）
  const context = await siteContext(env, actor, projectId, siteId);
  if (!context) return failure("forbidden", 403);
  if (route.method === "GET") {
    if (route.operation === "connection") return connection(context);
    const keys = [...input.query.keys()];
    const period = input.query.get("period");
    if (keys.length !== 1 || keys[0] !== "period" || !PERIODS.includes(period as AnalyticsPeriod)) return failure("invalid_request", 400);
    return ok(await report(env, context, period as AnalyticsPeriod, now));
  }
  // 変更・確認・再試行は owner だけ
  if (context.role !== "owner") return failure("forbidden", 403);
  if (route.operation === "unsupported") return failure("not_supported", 409);
  if (!context.origin) return failure("unsupported_site", 409);
  const body = input.body ?? {};
  switch (route.step) {
    case "prepare": return route.source === "ga4" ? prepareGa4(env, actor, context, body, now) : prepareSearchConsole(env, actor, context, body, now);
    case "disconnect-prepare": return prepareDisconnect(env, actor, context, route.source, body, now);
    case "apply": case "disconnect-apply": return apply(env, actor, context, route.source, route.step === "apply" ? "connect" : "disconnect", body);
    case "verify": return route.source === "ga4" ? verifyGa4(env, context, body) : verifySearchConsole(env, context, body);
    case "retry": return retry(env, context, route.source, body, now);
  }
}

// ---- 接続状態 ----

function connectionBody(context: SiteContext, targetOrigin: string): SiteAnalyticsConnection {
  const row = context.origin ? context.connection : null;
  const tag = row?.ga4_tracking_tag_state as SiteAnalyticsConnection["ga4"]["trackingTagState"] | undefined;
  const ga4: SiteAnalyticsConnection["ga4"] = !row || row.ga4_property_id === null
    ? { measurementId: null, trackingTagState: "not-configured", propertyId: null, reportingState: "not-connected", propertyTimeZone: null, lastSyncedAt: null }
    : {
      // 測定IDは「タグが見つかった・確認できなかった」ときだけ示す（未設定のタグに ID を付けない）
      measurementId: tag === "not-configured" ? null : row.ga4_measurement_id,
      trackingTagState: tag ?? "not-configured",
      propertyId: row.ga4_property_id,
      reportingState: (row.ga4_stream_origin === context.origin ? row.ga4_reporting_state : "property-mismatch") as SiteAnalyticsConnection["ga4"]["reportingState"],
      propertyTimeZone: row.ga4_time_zone,
      lastSyncedAt: isoSeconds(row.ga4_last_synced_at)
    };
  const searchConsole: SiteAnalyticsConnection["searchConsole"] = !row || row.gsc_property_value === null || (row.gsc_property_kind !== "url-prefix" && row.gsc_property_kind !== "domain")
    ? { property: null, ownershipState: "not-verified", verificationMethod: null, reportingState: "not-connected", lastSyncedAt: null }
    : {
      property: { kind: row.gsc_property_kind, value: row.gsc_property_value },
      // 所有権の確認方法は Studio が扱わない（このホストでは確認済みと示さない）
      ownershipState: (row.gsc_ownership_state === "verified" ? "not-verified" : row.gsc_ownership_state) as SiteAnalyticsConnection["searchConsole"]["ownershipState"],
      verificationMethod: null,
      reportingState: (row.gsc_property_kind === "url-prefix" && row.gsc_property_value === `${context.origin}/` ? row.gsc_reporting_state : "property-mismatch") as SiteAnalyticsConnection["searchConsole"]["reportingState"],
      lastSyncedAt: isoSeconds(row.gsc_last_synced_at)
    };
  return { target: { projectId: context.projectId, siteId: context.siteId, siteOrigin: targetOrigin }, ga4, searchConsole };
}

function connection(context: SiteContext): SiteAnalyticsResult {
  if (!context.targetOrigin) return failure("unsupported_site", 409);
  const target: SiteAnalyticsTarget = { projectId: context.projectId, siteId: context.siteId, siteOrigin: context.targetOrigin };
  try { return ok(parseSiteAnalyticsConnection(connectionBody(context, context.targetOrigin), target)); }
  catch { logAnalyticsFailure("config", "invalid-response"); return failure("service_unavailable", 503); }
}

// ---- 集計 ----

type AnySource = SourceResult<Ga4Report> | SourceResult<SearchConsoleReport>;

/** 返す前に閲覧契約の parser を通す。通らない source は failed にする。 */
function checkedSource<T extends AnySource>(context: Pick<SiteContext, "projectId" | "siteId">, period: AnalyticsPeriod, source: Source, result: T): T | null {
  const scope = { projectId: context.projectId, siteId: context.siteId, period };
  try {
    const parsed = parseSiteAnalyticsSnapshot({ ...scope, ga4: source === "ga4" ? result : { state: "not-connected" }, searchConsole: source === "search-console" ? result : { state: "not-connected" } }, scope);
    return (source === "ga4" ? parsed.ga4 : parsed.searchConsole) as T;
  } catch {
    logAnalyticsFailure(source === "ga4" ? "ga4_report" : "gsc_query", "invalid-response");
    return null;
  }
}

async function readCache<T extends AnySource>(env: SiteAnalyticsEnv, context: Pick<SiteContext, "projectId" | "siteId">, source: Source, period: AnalyticsPeriod, version: number, rangeEnd: string): Promise<T | null> {
  const row = await env.DB.prepare(`
    SELECT result_json FROM site_analytics_cache
     WHERE site_id = ?1 AND source = ?2 AND period = ?3 AND connection_version = ?4 AND range_end = ?5 AND expires_at > unixepoch()
     LIMIT 1
  `).bind(context.siteId, source, period, version, rangeEnd).first<{ readonly result_json: unknown }>();
  if (!row || typeof row.result_json !== "string") return null;
  let value: unknown;
  try { value = JSON.parse(row.result_json) as unknown; } catch { return null; }
  return checkedSource(context, period, source, value as T);
}

const STATE_COLUMN: Readonly<Record<Source, { readonly state: string; readonly synced: string; readonly property: string }>> = {
  ga4: { state: "ga4_reporting_state", synced: "ga4_last_synced_at", property: "ga4_property_id" },
  "search-console": { state: "gsc_reporting_state", synced: "gsc_last_synced_at", property: "gsc_property_value" }
};

async function recordSuccess(env: SiteAnalyticsEnv, siteId: string, source: Source, period: AnalyticsPeriod, version: number, rangeEnd: string, result: AnySource): Promise<void> {
  const column = STATE_COLUMN[source];
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO site_analytics_cache (site_id, source, period, connection_version, range_end, result_json, fetched_at, expires_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, unixepoch(), unixepoch() + ${CACHE_SECONDS}
       WHERE EXISTS (SELECT 1 FROM site_analytics_connections WHERE site_id = ?1 AND version = ?4)
      ON CONFLICT (site_id, source, period) DO UPDATE SET
        connection_version = excluded.connection_version, range_end = excluded.range_end, result_json = excluded.result_json,
        fetched_at = excluded.fetched_at, expires_at = excluded.expires_at
    `).bind(siteId, source, period, version, rangeEnd, JSON.stringify(result)),
    env.DB.prepare(`UPDATE site_analytics_connections SET ${column.state} = 'connected', ${column.synced} = unixepoch()
                     WHERE site_id = ?1 AND version = ?2 AND ${column.property} IS NOT NULL`).bind(siteId, version)
  ]);
}

async function recordState(env: SiteAnalyticsEnv, siteId: string, source: Source, version: number, state: string, clearCache: boolean): Promise<void> {
  const column = STATE_COLUMN[source];
  await env.DB.batch([
    env.DB.prepare(`UPDATE site_analytics_connections SET ${column.state} = ?3 WHERE site_id = ?1 AND version = ?2 AND ${column.property} IS NOT NULL`).bind(siteId, version, state),
    ...(clearCache ? [env.DB.prepare("DELETE FROM site_analytics_cache WHERE site_id = ?1 AND source = ?2").bind(siteId, source)] : [])
  ]);
}

/** Google の失敗を接続状態に反映する。権限失効と不一致では cache を消し、古い値を返さない。 */
async function failedSource(env: SiteAnalyticsEnv, siteId: string, source: Source, version: number, error: unknown): Promise<{ readonly state: "permission-expired" | "failed" }> {
  if (!(error instanceof GoogleApiError)) {
    logAnalyticsFailure(source === "ga4" ? "ga4_report" : "gsc_query", "upstream");
    return { state: "failed" };
  }
  if (error.category === "permission") { await recordState(env, siteId, source, version, "permission-revoked", true); return { state: "permission-expired" }; }
  if (error.category === "not-found") { await recordState(env, siteId, source, version, "property-mismatch", true); return { state: "failed" }; }
  if (error.category === "quota") await recordState(env, siteId, source, version, "quota-limited", false);
  return { state: "failed" };
}

type LoaderContext = Pick<SiteContext, "projectId" | "siteId" | "origin" | "connection">;

async function ga4Source(env: SiteAnalyticsEnv, context: LoaderContext, period: AnalyticsPeriod, now: number, force = false): Promise<SourceResult<Ga4Report>> {
  const row = context.connection, origin = context.origin;
  if (!origin || !row || row.ga4_property_id === null) return { state: "not-connected" };
  if (row.ga4_stream_origin !== origin || row.ga4_stream_id === null || row.ga4_time_zone === null) return { state: "failed" };
  if (!force) {
    if (row.ga4_reporting_state === "permission-revoked" || row.ga4_reporting_state === "permission-required") return { state: "permission-expired" };
    if (row.ga4_reporting_state === "property-mismatch") return { state: "failed" };
  }
  try {
    const window = ga4Window(period, row.ga4_time_zone, now);
    if (!force) {
      const cached = await readCache<SourceResult<Ga4Report>>(env, context, "ga4", period, row.version, window.range.end);
      if (cached) return cached;
    }
    const account = await loadServiceAccount(env.STUDIO_ANALYTICS_GOOGLE_SA_JSON);
    if (!account) return { state: "failed" };
    try {
      const result = checkedSource(context, period, "ga4", await loadGa4Report(new GoogleAnalyticsClient(account), {
        propertyId: row.ga4_property_id, streamId: row.ga4_stream_id, hostName: new URL(origin).hostname, timeZone: row.ga4_time_zone
      }, window, new Date(now).toISOString()));
      if (!result) return { state: "failed" };
      await recordSuccess(env, context.siteId, "ga4", period, row.version, window.range.end, result);
      return result;
    } catch (error) {
      return await failedSource(env, context.siteId, "ga4", row.version, error);
    }
  } catch {
    logAnalyticsFailure("ga4_report", "upstream");
    return { state: "failed" };
  }
}

async function searchConsoleSource(env: SiteAnalyticsEnv, context: LoaderContext, period: AnalyticsPeriod, now: number, force = false): Promise<SourceResult<SearchConsoleReport>> {
  const row = context.connection, origin = context.origin;
  if (!origin || !row || row.gsc_property_value === null) return { state: "not-connected" };
  const siteUrl = `${origin}/`;
  if (row.gsc_property_kind !== "url-prefix" || row.gsc_property_value !== siteUrl) return { state: "failed" };
  if (!force) {
    if (row.gsc_reporting_state === "permission-revoked" || row.gsc_reporting_state === "permission-required") return { state: "permission-expired" };
    if (row.gsc_reporting_state === "property-mismatch") return { state: "failed" };
  }
  try {
    const window: ReportWindow = searchConsoleWindow(period, now);
    if (!force) {
      const cached = await readCache<SourceResult<SearchConsoleReport>>(env, context, "search-console", period, row.version, window.range.end);
      if (cached) return cached;
    }
    const account = await loadServiceAccount(env.STUDIO_ANALYTICS_GOOGLE_SA_JSON);
    if (!account) return { state: "failed" };
    try {
      const result = checkedSource(context, period, "search-console", await loadSearchConsoleReport(new GoogleAnalyticsClient(account), { siteUrl, siteOrigin: origin }, window, new Date(now).toISOString()));
      if (!result) return { state: "failed" };
      await recordSuccess(env, context.siteId, "search-console", period, row.version, window.range.end, result);
      return result;
    } catch (error) {
      return await failedSource(env, context.siteId, "search-console", row.version, error);
    }
  } catch {
    logAnalyticsFailure("gsc_query", "upstream");
    return { state: "failed" };
  }
}

/** 2つの source は独立に取り、片方の失敗をもう片方に影響させない。返す前に閲覧契約の parser を通す。 */
async function report(env: SiteAnalyticsEnv, context: SiteContext, period: AnalyticsPeriod, now: number): Promise<SiteAnalyticsSnapshot> {
  const scope = { projectId: context.projectId, siteId: context.siteId, period };
  const [ga4, searchConsole] = await Promise.all([ga4Source(env, context, period, now), searchConsoleSource(env, context, period, now)]);
  return parseSiteAnalyticsSnapshot({ ...scope, ga4, searchConsole }, scope);
}

export type DashboardAnalyticsSummary =
  | { readonly status: "disconnected" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly data: { readonly period: { readonly start: string; readonly end: string }; readonly fetchedAt: string; readonly activeUsers: number | null; readonly pageViews: number | null } };

/**
 * Dashboard の要約: GA4 の28日（cache があればそれ、無ければ集計を1回）。未接続は disconnected、失敗は unavailable。
 * membership は dashboard() が確かめている。
 */
export async function dashboardAnalyticsSummary(
  env: SiteAnalyticsEnv, target: { readonly projectId: string; readonly siteId: string; readonly publicOrigin: string | null; readonly managed: boolean }, now = Date.now()
): Promise<DashboardAnalyticsSummary> {
  try {
    const origin = analyticsOrigin(target.publicOrigin, target.managed, publicSitesOrigin(env.PUBLIC_SITES_ORIGIN));
    if (!origin) return { status: "disconnected" };
    const row = connectionFrom(await env.DB.prepare(`SELECT ${CONNECTION_COLUMNS} FROM site_analytics_connections AS c WHERE c.site_id = ?1 LIMIT 1`)
      .bind(target.siteId).first<Record<string, unknown>>());
    if (!row || row.ga4_property_id === null) return { status: "disconnected" };
    const result = await ga4Source(env, { projectId: target.projectId, siteId: target.siteId, origin, connection: row }, "28d", now);
    if (result.state === "not-connected") return { status: "disconnected" };
    if (result.state === "permission-expired" || result.state === "failed") return { status: "unavailable" };
    const window = result.state === "empty" ? result.metadata : result.report;
    const timeZone = window.range.timezone;
    return {
      status: "ready",
      data: {
        period: { start: `${window.range.start}T00:00:00${zoneOffset(window.range.start, timeZone)}`, end: `${window.range.end}T23:59:59${zoneOffset(window.range.end, timeZone)}` },
        fetchedAt: result.state === "empty" ? result.metadata.lastUpdatedAt : result.lastUpdatedAt,
        activeUsers: result.state === "empty" ? 0 : result.report.activeUsers.current,
        pageViews: result.state === "empty" ? 0 : result.report.pageViews.current
      }
    };
  } catch {
    logAnalyticsFailure("ga4_report", "upstream");
    return { status: "unavailable" };
  }
}

// ---- 変更計画（prepare）----

async function client(env: SiteAnalyticsEnv): Promise<GoogleAnalyticsClient | null> {
  const account = await loadServiceAccount(env.STUDIO_ANALYTICS_GOOGLE_SA_JSON);
  return account ? new GoogleAnalyticsClient(account) : null;
}

function googleFailure(error: unknown): SiteAnalyticsResult {
  if (error instanceof GoogleApiError) {
    if (error.category === "permission" || error.category === "not-found") return failure("permission_required", 409);
    if (error.category === "quota") return failure("quota_limited", 429);
  } else logAnalyticsFailure("config", "upstream");
  return failure("google_unavailable", 502);
}

async function storePlan(env: SiteAnalyticsEnv, actor: SiteAnalyticsActor, context: SiteContext, action: SiteAnalyticsChangeAction, payload: Record<string, string>): Promise<string | null> {
  const token = randomToken();
  const version = context.connection?.version ?? 0;
  const [, inserted] = await env.DB.batch([
    env.DB.prepare("DELETE FROM site_analytics_plans WHERE site_id = ?1 AND expires_at <= unixepoch()").bind(context.siteId),
    env.DB.prepare(`
      INSERT INTO site_analytics_plans (token_hash, site_id, action, actor_subject, connection_version, payload_json, created_at, expires_at)
      SELECT ?1, s.id, ?3, ?4, ?5, ?6, unixepoch(), unixepoch() + ${PLAN_SECONDS}
        FROM sites AS s
        JOIN project_members AS m ON m.project_id = s.project_id
       WHERE s.id = ?2 AND s.project_id = ?7 AND m.access_subject = ?4 AND m.role = 'owner'
         AND ((?5 = 0 AND NOT EXISTS (SELECT 1 FROM site_analytics_connections WHERE site_id = ?2))
           OR EXISTS (SELECT 1 FROM site_analytics_connections WHERE site_id = ?2 AND version = ?5))
    `).bind(await tokenHash(token), context.siteId, action, actor.subject, version, JSON.stringify(payload), context.projectId)
  ]);
  return changed(inserted) ? token : null;
}

async function planResponse(env: SiteAnalyticsEnv, actor: SiteAnalyticsActor, context: SiteContext, action: SiteAnalyticsChangeAction, payload: Record<string, string>,
  summary: string, changes: readonly { readonly label: string; readonly currentValue: string | null; readonly nextValue: string | null }[], now: number): Promise<SiteAnalyticsResult> {
  const origin = context.origin!;
  const token = await storePlan(env, actor, context, action, payload);
  if (!token) return failure("version_conflict", 409);
  const target = { projectId: context.projectId, siteId: context.siteId, siteOrigin: origin };
  const plan = { target, action, publicOrigin: origin, summary, changes, confirmationToken: token, expiresAt: new Date(now + PLAN_SECONDS * 1000).toISOString() };
  return ok(parseSiteAnalyticsChangePlan(plan, target));
}

async function prepareGa4(env: SiteAnalyticsEnv, actor: SiteAnalyticsActor, context: SiteContext, body: Record<string, unknown>, now: number): Promise<SiteAnalyticsResult> {
  if (!hasExactKeys(body, ["propertyId"]) || typeof body.propertyId !== "string" || !/^\d{4,20}$/u.test(body.propertyId)) return failure("invalid_request", 400);
  const google = await client(env);
  if (!google) return failure("analytics_unavailable", 503);
  const propertyId = body.propertyId, origin = context.origin!;
  let timeZone: string, streams: readonly Ga4WebStream[];
  try {
    [{ timeZone }, streams] = await Promise.all([google.ga4Property(propertyId), google.ga4WebStreams(propertyId)]);
  } catch (error) { return googleFailure(error); }
  // defaultUri の origin がサイトの公開 origin と完全一致する Web ストリームがちょうど1つのときだけ接続できる
  const matches = streams.filter((stream) => stream.origin === origin);
  if (matches.length !== 1) return failure("property_mismatch", 409);
  const stream = matches[0]!, row = context.connection;
  return planResponse(env, actor, context, "connect-ga4",
    { propertyId, streamId: stream.streamId, measurementId: stream.measurementId, timeZone, streamOrigin: origin },
    `GA4 プロパティ ${propertyId} の Web データストリーム（${stream.measurementId}）を ${origin} のレポートに接続します。`,
    [
      { label: "GA4プロパティID", currentValue: row?.ga4_property_id ?? null, nextValue: propertyId },
      { label: "測定ID", currentValue: row?.ga4_property_id ? row.ga4_measurement_id : null, nextValue: stream.measurementId },
      { label: "時間帯", currentValue: row?.ga4_property_id ? row.ga4_time_zone : null, nextValue: timeZone }
    ], now);
}

async function prepareSearchConsole(env: SiteAnalyticsEnv, actor: SiteAnalyticsActor, context: SiteContext, body: Record<string, unknown>, now: number): Promise<SiteAnalyticsResult> {
  const property = body.property;
  if (!hasExactKeys(body, ["property"]) || !isRecord(property) || !hasExactKeys(property, ["kind", "value"]) || typeof property.kind !== "string" || typeof property.value !== "string" || property.value.length > 2048) {
    return failure("invalid_request", 400);
  }
  const origin = context.origin!, siteUrl = `${origin}/`;
  // サイトの公開 origin のルート URL-prefix と完全一致するものだけ（sc-domain: やパス付きは使わない）
  if (property.kind !== "url-prefix" || property.value !== siteUrl) return failure("property_mismatch", 409);
  const google = await client(env);
  if (!google) return failure("analytics_unavailable", 503);
  let permissionLevel: string;
  try { ({ permissionLevel } = await google.searchConsoleSite(siteUrl)); }
  catch (error) { return googleFailure(error); }
  if (!GSC_ALLOWED_PERMISSIONS.has(permissionLevel)) return failure("permission_required", 409);
  const row = context.connection;
  return planResponse(env, actor, context, "connect-search-console", { kind: "url-prefix", value: siteUrl },
    `Search Console プロパティ ${siteUrl} を ${origin} のレポートに接続します。`,
    [{ label: "Search Consoleプロパティ", currentValue: row?.gsc_property_value ?? null, nextValue: siteUrl }], now);
}

async function prepareDisconnect(env: SiteAnalyticsEnv, actor: SiteAnalyticsActor, context: SiteContext, source: Source, body: Record<string, unknown>, now: number): Promise<SiteAnalyticsResult> {
  if (!hasExactKeys(body, [])) return failure("invalid_request", 400);
  const row = context.connection, origin = context.origin!;
  if (source === "ga4") {
    if (!row?.ga4_property_id) return failure("not_connected", 409);
    return planResponse(env, actor, context, "disconnect-ga4", { propertyId: row.ga4_property_id },
      `${origin} の GA4 レポート接続と集計キャッシュを解除します。計測タグは変更しません。`,
      [{ label: "GA4プロパティID", currentValue: row.ga4_property_id, nextValue: null }], now);
  }
  if (!row?.gsc_property_value) return failure("not_connected", 409);
  return planResponse(env, actor, context, "disconnect-search-console", { value: row.gsc_property_value },
    `${origin} の Search Console レポート接続と集計キャッシュを解除します。`,
    [{ label: "Search Consoleプロパティ", currentValue: row.gsc_property_value, nextValue: null }], now);
}

// ---- 反映（apply）----

/** plan（token・site・action・actor・接続 version・期限）と、現在 owner であることを書き込みと同じ文で確かめる。 */
const PLAN_GUARD = `EXISTS (SELECT 1 FROM site_analytics_plans AS p
                     WHERE p.token_hash = ?4 AND p.site_id = ?1 AND p.action = ?5 AND p.actor_subject = ?3
                       AND p.connection_version = ?6 AND p.expires_at > unixepoch())
       AND EXISTS (SELECT 1 FROM sites AS s JOIN project_members AS m ON m.project_id = s.project_id
                    WHERE s.id = ?1 AND s.project_id = ?2 AND m.access_subject = ?3 AND m.role = 'owner')`;

function payloadString(payload: Record<string, unknown>, key: string, pattern: RegExp): string | null {
  const value = payload[key];
  return typeof value === "string" && pattern.test(value) ? value : null;
}

async function apply(env: SiteAnalyticsEnv, actor: SiteAnalyticsActor, context: SiteContext, source: Source, kind: "connect" | "disconnect", body: Record<string, unknown>): Promise<SiteAnalyticsResult> {
  if (!hasExactKeys(body, ["confirmationToken"]) || typeof body.confirmationToken !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(body.confirmationToken)) return failure("invalid_request", 400);
  const action: SiteAnalyticsChangeAction = source === "ga4"
    ? kind === "connect" ? "connect-ga4" : "disconnect-ga4"
    : kind === "connect" ? "connect-search-console" : "disconnect-search-console";
  const hash = await tokenHash(body.confirmationToken);
  const plan = await env.DB.prepare(`
    SELECT p.connection_version, p.payload_json
      FROM site_analytics_plans AS p
      JOIN sites AS s ON s.id = p.site_id
      JOIN project_members AS m ON m.project_id = s.project_id
     WHERE p.token_hash = ?1 AND p.site_id = ?2 AND p.action = ?3 AND p.actor_subject = ?4 AND p.expires_at > unixepoch()
       AND s.project_id = ?5 AND m.access_subject = ?4 AND m.role = 'owner'
     LIMIT 1
  `).bind(hash, context.siteId, action, actor.subject, context.projectId).first<{ readonly connection_version: unknown; readonly payload_json: unknown }>();
  // 期限切れ・使用済み・別の人や別サイト・別操作の token は同じ扱い
  if (!plan || typeof plan.connection_version !== "number" || typeof plan.payload_json !== "string") return failure("plan_invalid", 409);
  let payload: Record<string, unknown>;
  try { const parsed = JSON.parse(plan.payload_json) as unknown; if (!isRecord(parsed)) return failure("plan_invalid", 409); payload = parsed; }
  catch { return failure("plan_invalid", 409); }
  const version = plan.connection_version;
  if (version !== (context.connection?.version ?? 0)) return failure("version_conflict", 409);
  const origin = context.origin!;
  const common = [context.siteId, context.projectId, actor.subject, hash, action, version] as const;
  let writes: readonly { readonly query: string; readonly values: readonly unknown[] }[];
  if (action === "connect-ga4") {
    const propertyId = payloadString(payload, "propertyId", /^\d{4,20}$/u), streamId = payloadString(payload, "streamId", /^\d{1,20}$/u);
    const measurementId = payloadString(payload, "measurementId", /^G-[A-Za-z0-9]{4,24}$/u), timeZone = payloadString(payload, "timeZone", /^[A-Za-z0-9_+\-/]{1,80}$/u);
    if (!propertyId || !streamId || !measurementId || !timeZone) return failure("plan_invalid", 409);
    // 準備の後に公開 origin が変わっていたら接続しない
    if (payload.streamOrigin !== origin) return failure("property_mismatch", 409);
    const tagState = await detectTrackingTag(origin, measurementId);
    const values = [...common, propertyId, streamId, origin, measurementId, timeZone, tagState];
    writes = [
      { query: `INSERT INTO site_analytics_connections (site_id, version, ga4_property_id, ga4_stream_id, ga4_stream_origin, ga4_measurement_id, ga4_time_zone, ga4_reporting_state, ga4_tracking_tag_state, updated_by_subject)
                SELECT ?1, 1, ?7, ?8, ?9, ?10, ?11, 'connected', ?12, ?3
                 WHERE ?6 = 0 AND NOT EXISTS (SELECT 1 FROM site_analytics_connections WHERE site_id = ?1) AND ${PLAN_GUARD}`, values },
      { query: `UPDATE site_analytics_connections
                   SET version = version + 1, ga4_property_id = ?7, ga4_stream_id = ?8, ga4_stream_origin = ?9, ga4_measurement_id = ?10, ga4_time_zone = ?11,
                       ga4_reporting_state = 'connected', ga4_tracking_tag_state = ?12, ga4_last_synced_at = NULL, updated_by_subject = ?3, updated_at = unixepoch()
                 WHERE site_id = ?1 AND version = ?6 AND ${PLAN_GUARD}`, values }
    ];
  } else if (action === "connect-search-console") {
    if (payload.kind !== "url-prefix" || payload.value !== `${origin}/`) return failure("property_mismatch", 409);
    const values = [...common, `${origin}/`];
    writes = [
      { query: `INSERT INTO site_analytics_connections (site_id, version, gsc_property_kind, gsc_property_value, gsc_reporting_state, updated_by_subject)
                SELECT ?1, 1, 'url-prefix', ?7, 'connected', ?3
                 WHERE ?6 = 0 AND NOT EXISTS (SELECT 1 FROM site_analytics_connections WHERE site_id = ?1) AND ${PLAN_GUARD}`, values },
      { query: `UPDATE site_analytics_connections
                   SET version = version + 1, gsc_property_kind = 'url-prefix', gsc_property_value = ?7, gsc_reporting_state = 'connected', gsc_last_synced_at = NULL,
                       updated_by_subject = ?3, updated_at = unixepoch()
                 WHERE site_id = ?1 AND version = ?6 AND ${PLAN_GUARD}`, values }
    ];
  } else if (action === "disconnect-ga4") {
    const propertyId = payloadString(payload, "propertyId", /^\d{4,20}$/u);
    if (!propertyId) return failure("plan_invalid", 409);
    writes = [{ query: `UPDATE site_analytics_connections
                           SET version = version + 1, ga4_property_id = NULL, ga4_stream_id = NULL, ga4_stream_origin = NULL, ga4_measurement_id = NULL, ga4_time_zone = NULL,
                               ga4_reporting_state = 'not-connected', ga4_tracking_tag_state = 'not-configured', ga4_last_synced_at = NULL,
                               updated_by_subject = ?3, updated_at = unixepoch()
                         WHERE site_id = ?1 AND version = ?6 AND ga4_property_id = ?7 AND ${PLAN_GUARD}`, values: [...common, propertyId] }];
  } else {
    const value = payloadString(payload, "value", /^https:\/\/\S{1,2040}$/u);
    if (!value) return failure("plan_invalid", 409);
    writes = [{ query: `UPDATE site_analytics_connections
                           SET version = version + 1, gsc_property_kind = NULL, gsc_property_value = NULL, gsc_reporting_state = 'not-connected', gsc_last_synced_at = NULL,
                               updated_by_subject = ?3, updated_at = unixepoch()
                         WHERE site_id = ?1 AND version = ?6 AND gsc_property_value = ?7 AND ${PLAN_GUARD}`, values: [...common, value] }];
  }
  const results = await env.DB.batch([
    ...writes.map((write) => env.DB.prepare(write.query).bind(...write.values)),
    // 書き込みが通ったときだけ plan を消費し、古い version の cache を消す
    env.DB.prepare("DELETE FROM site_analytics_plans WHERE token_hash = ?1 AND EXISTS (SELECT 1 FROM site_analytics_connections WHERE site_id = ?2 AND version = ?3)")
      .bind(hash, context.siteId, version + 1),
    env.DB.prepare("DELETE FROM site_analytics_cache WHERE site_id = ?1 AND connection_version < (SELECT version FROM site_analytics_connections WHERE site_id = ?1)")
      .bind(context.siteId)
  ]);
  if (!results.slice(0, writes.length).some(changed)) return failure("version_conflict", 409);
  return ok({ status: "applied" });
}

// ---- 確認・再試行 ----

async function verifyGa4(env: SiteAnalyticsEnv, context: SiteContext, body: Record<string, unknown>): Promise<SiteAnalyticsResult> {
  if (!hasExactKeys(body, [])) return failure("invalid_request", 400);
  const row = context.connection, origin = context.origin!;
  if (!row?.ga4_property_id || !row.ga4_stream_id) return failure("not_connected", 409);
  const google = await client(env);
  if (!google) return failure("analytics_unavailable", 503);
  let state = "connected", timeZone = row.ga4_time_zone, measurementId = row.ga4_measurement_id, tagState = row.ga4_tracking_tag_state;
  if (row.ga4_stream_origin !== origin) state = "property-mismatch";
  else {
    try {
      const [property, streams] = await Promise.all([google.ga4Property(row.ga4_property_id), google.ga4WebStreams(row.ga4_property_id)]);
      const stream = streams.find((item) => item.streamId === row.ga4_stream_id);
      // 接続したストリームが消えた・別 origin に変わったときは不一致（ほかのストリームへ自動で切り替えない）
      if (!stream || stream.origin !== origin) state = "property-mismatch";
      else {
        timeZone = property.timeZone;
        measurementId = stream.measurementId;
        tagState = await detectTrackingTag(origin, stream.measurementId);
      }
    } catch (error) {
      state = error instanceof GoogleApiError
        ? error.category === "permission" ? "permission-revoked" : error.category === "not-found" ? "property-mismatch" : error.category === "quota" ? "quota-limited" : "failed"
        : "failed";
    }
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE site_analytics_connections SET ga4_reporting_state = ?3, ga4_time_zone = ?4, ga4_measurement_id = ?5, ga4_tracking_tag_state = ?6
                     WHERE site_id = ?1 AND version = ?2 AND ga4_property_id IS NOT NULL`).bind(context.siteId, row.version, state, timeZone, measurementId, tagState),
    env.DB.prepare("DELETE FROM site_analytics_cache WHERE site_id = ?1 AND source = 'ga4'").bind(context.siteId)
  ]);
  return ok({ status: "verified" });
}

async function verifySearchConsole(env: SiteAnalyticsEnv, context: SiteContext, body: Record<string, unknown>): Promise<SiteAnalyticsResult> {
  if (!hasExactKeys(body, [])) return failure("invalid_request", 400);
  const row = context.connection, siteUrl = `${context.origin!}/`;
  if (!row?.gsc_property_value) return failure("not_connected", 409);
  const google = await client(env);
  if (!google) return failure("analytics_unavailable", 503);
  let state = "connected";
  if (row.gsc_property_kind !== "url-prefix" || row.gsc_property_value !== siteUrl) state = "property-mismatch";
  else {
    try {
      const { permissionLevel } = await google.searchConsoleSite(siteUrl);
      if (!GSC_ALLOWED_PERMISSIONS.has(permissionLevel)) state = "permission-required";
    } catch (error) {
      state = error instanceof GoogleApiError
        ? error.category === "permission" ? "permission-revoked" : error.category === "not-found" ? "permission-required" : error.category === "quota" ? "quota-limited" : "failed"
        : "failed";
    }
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE site_analytics_connections SET gsc_reporting_state = ?3 WHERE site_id = ?1 AND version = ?2 AND gsc_property_value IS NOT NULL`).bind(context.siteId, row.version, state),
    env.DB.prepare("DELETE FROM site_analytics_cache WHERE site_id = ?1 AND source = 'search-console'").bind(context.siteId)
  ]);
  return ok({ status: "verified" });
}

/** cache を捨てて28日を取り直す。結果は接続状態（reportingState・lastSyncedAt）に反映する。 */
async function retry(env: SiteAnalyticsEnv, context: SiteContext, source: Source, body: Record<string, unknown>, now: number): Promise<SiteAnalyticsResult> {
  if (!hasExactKeys(body, [])) return failure("invalid_request", 400);
  const row = context.connection;
  if (source === "ga4" ? !row?.ga4_property_id : !row?.gsc_property_value) return failure("not_connected", 409);
  if (!await loadServiceAccount(env.STUDIO_ANALYTICS_GOOGLE_SA_JSON)) return failure("analytics_unavailable", 503);
  await env.DB.prepare("DELETE FROM site_analytics_cache WHERE site_id = ?1 AND source = ?2").bind(context.siteId, source).all();
  if (source === "ga4") await ga4Source(env, context, "28d", now, true);
  else await searchConsoleSource(env, context, "28d", now, true);
  return ok({ status: "retried" });
}
