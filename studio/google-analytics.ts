import { parseAnalyticsPagePath } from "../src/analytics-parse.js";
import type { AnalyticsPeriod, Ga4Report, LocalRange, Metric, ReportWindow, SearchConsoleReport, SourceResult } from "../src/analytics-types.js";

/**
 * Studio のサイト分析が使う Google API クライアント（GA4 Admin / Data と Search Console）。
 * 認証は Studio 専用サービスアカウント1つ（Worker secret の JSON 鍵）で、scope は読み取り2つだけ。
 * 鍵・access token・Google の応答本文はログ・戻り値・D1 に出さない。ログは固定の operation・分類・HTTP status だけ。
 */
export const GOOGLE_ANALYTICS_SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly"
] as const;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ADMIN_API = "https://analyticsadmin.googleapis.com/v1beta";
const DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const SEARCH_CONSOLE_API = "https://www.googleapis.com/webmasters/v3";
const GOOGLE_TIMEOUT_MILLISECONDS = 10_000;
const MAX_GOOGLE_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_GOOGLE_ERROR_BYTES = 64 * 1024;
const SITE_HTML_TIMEOUT_MILLISECONDS = 4_000;
const MAX_SITE_HTML_BYTES = 1024 * 1024;
const MAX_SERVICE_ACCOUNT_BYTES = 16 * 1024;
const SEARCH_CONSOLE_TIME_ZONE = "America/Los_Angeles";
const TOP_PAGES = 20;
const SEARCH_CONSOLE_PREVIOUS_PAGE_ROWS = 1000;
/** final データとして扱う遅れ（Pacific Time の今日から何日前まで）。 */
const SEARCH_CONSOLE_FINAL_DELAY_DAYS = 3;
/** Search Analytics API が返す履歴の長さ。 */
const SEARCH_CONSOLE_RETENTION_MONTHS = 16;

export type GoogleFailureCategory =
  | "credentials" | "permission" | "not-found" | "quota" | "upstream" | "invalid-response" | "timeout" | "network" | "redirect";
export type GoogleOperation = "token" | "ga4_property" | "ga4_streams" | "ga4_report" | "gsc_site" | "gsc_query" | "site_html" | "config";

export class GoogleApiError extends Error {
  constructor(readonly category: GoogleFailureCategory, readonly upstreamStatus: number | null = null) {
    super("Google API request failed");
    this.name = "GoogleApiError";
  }
}

/** 固定の operation・分類・HTTP status だけを記録する。鍵・token・ID・応答本文は渡さない。 */
export function logAnalyticsFailure(operation: GoogleOperation, category: GoogleFailureCategory, upstreamStatus: number | null = null): void {
  console.warn("NIHO Studio analytics failure", { operation, category, ...(upstreamStatus === null ? {} : { upstreamStatus }) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---- サービスアカウントと access token ----

type ServiceAccount = { readonly clientEmail: string; readonly keyId: string | null; readonly privateKey: CryptoKey; readonly fingerprint: string };
type CachedToken = { readonly fingerprint: string; readonly token: string; readonly expiresAt: number };

let accountCache: { readonly fingerprint: string; readonly account: Promise<ServiceAccount | null> } | null = null;
let tokenCache: CachedToken | null = null;
let tokenInFlight: { readonly fingerprint: string; readonly promise: Promise<string> } | null = null;

async function importServiceAccount(raw: string, fingerprint: string): Promise<ServiceAccount | null> {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { return null; }
  if (!isRecord(value) || value.type !== "service_account") return null;
  const clientEmail = value.client_email, pem = value.private_key, keyId = value.private_key_id;
  if (typeof clientEmail !== "string" || clientEmail.length > 254 || !/^[^\s@]+@[^\s@]+$/u.test(clientEmail)) return null;
  if (typeof pem !== "string" || pem.length > 8192) return null;
  if (keyId !== undefined && (typeof keyId !== "string" || !/^[A-Za-z0-9]{1,128}$/u.test(keyId))) return null;
  const match = /^\s*-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----\s*$/u.exec(pem);
  if (!match) return null;
  let der: Uint8Array;
  try { der = Uint8Array.from(atob(match[1]!.replace(/\s+/gu, "")), (character) => character.charCodeAt(0)); } catch { return null; }
  try {
    const keyData = der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer;
    const privateKey = await crypto.subtle.importKey("pkcs8", keyData, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    return { clientEmail, keyId: typeof keyId === "string" ? keyId : null, privateKey, fingerprint };
  } catch { return null; }
}

/** secret が無い・壊れているときは null（呼び出し側で「利用できない」として扱う）。 */
export async function loadServiceAccount(raw: string | undefined): Promise<ServiceAccount | null> {
  if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_SERVICE_ACCOUNT_BYTES) return null;
  const fingerprint = await sha256Hex(raw);
  let entry = accountCache;
  if (!entry || entry.fingerprint !== fingerprint) {
    tokenCache = null;
    tokenInFlight = null;
    entry = { fingerprint, account: importServiceAccount(raw, fingerprint) };
    accountCache = entry;
  }
  const account = await entry.account;
  if (!account) logAnalyticsFailure("config", "credentials");
  return account;
}

/** 上限までだけ読み、超えた分は読まずに打ち切る（truncated で知らせる）。 */
async function readBoundedText(response: Response, maximumBytes: number): Promise<{ readonly text: string; readonly truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0, truncated = false;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (total + chunk.value.byteLength > maximumBytes) {
      chunks.push(chunk.value.subarray(0, maximumBytes - total));
      total = maximumBytes;
      truncated = true;
      await reader.cancel("response too large");
      break;
    }
    chunks.push(chunk.value);
    total += chunk.value.byteLength;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return { text: new TextDecoder("utf-8").decode(body), truncated };
}

function quotaError(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.error)) return false;
  if (value.error.status === "RESOURCE_EXHAUSTED") return true;
  const errors = value.error.errors;
  return Array.isArray(errors) && errors.some((item) => isRecord(item) && ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "dailyLimitExceeded"].includes(item.reason as string));
}

async function failureFrom(response: Response): Promise<GoogleApiError> {
  let body: unknown = null;
  try {
    const { text, truncated } = await readBoundedText(response, MAX_GOOGLE_ERROR_BYTES);
    if (!truncated && text) body = JSON.parse(text) as unknown;
  } catch { body = null; }
  const status = response.status;
  if (status === 429 || quotaError(body)) return new GoogleApiError("quota", status);
  if (status === 401 || status === 403) return new GoogleApiError("permission", status);
  if (status === 404) return new GoogleApiError("not-found", status);
  return new GoogleApiError("upstream", status);
}

/** redirect を追わず、timeout と応答サイズ上限を付けて JSON を読む。 */
async function boundedGoogleJson(url: string, init: { readonly method: "GET" | "POST"; readonly headers: Record<string, string>; readonly body?: string }, operation: GoogleOperation): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MILLISECONDS);
  try {
    let response: Response;
    try {
      response = await fetch(url, { method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }), redirect: "manual", cache: "no-store", signal: controller.signal });
    } catch {
      throw new GoogleApiError(controller.signal.aborted ? "timeout" : "network");
    }
    if (response.redirected || (response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
      await response.body?.cancel().catch(() => undefined);
      throw new GoogleApiError("redirect", response.status || null);
    }
    if (!response.ok) throw await failureFrom(response);
    const mediaType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      await response.body?.cancel().catch(() => undefined);
      throw new GoogleApiError("invalid-response", response.status);
    }
    let text: string, truncated: boolean;
    try { ({ text, truncated } = await readBoundedText(response, MAX_GOOGLE_RESPONSE_BYTES)); }
    catch { throw new GoogleApiError(controller.signal.aborted ? "timeout" : "network", response.status); }
    if (truncated) throw new GoogleApiError("invalid-response", response.status);
    try { return JSON.parse(text) as unknown; } catch { throw new GoogleApiError("invalid-response", response.status); }
  } catch (error) {
    const failure = error instanceof GoogleApiError ? error : new GoogleApiError("upstream");
    logAnalyticsFailure(operation, failure.category, failure.upstreamStatus);
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}

async function requestToken(account: ServiceAccount): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const header = { alg: "RS256", typ: "JWT", ...(account.keyId ? { kid: account.keyId } : {}) };
  const claims = { iss: account.clientEmail, scope: GOOGLE_ANALYTICS_SCOPES.join(" "), aud: TOKEN_URL, iat: issuedAt, exp: issuedAt + 3600 };
  const input = `${base64UrlBytes(encoder.encode(JSON.stringify(header)))}.${base64UrlBytes(encoder.encode(JSON.stringify(claims)))}`;
  let signature: ArrayBuffer;
  try { signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", account.privateKey, encoder.encode(input)); }
  catch { logAnalyticsFailure("token", "credentials"); throw new GoogleApiError("credentials"); }
  let value: unknown;
  try {
    value = await boundedGoogleJson(TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${input}.${base64UrlBytes(new Uint8Array(signature))}` }).toString()
    }, "token");
  } catch (error) {
    // token endpoint の 400 / 401 / 403 は鍵・アカウントの問題（サイトの権限ではない）
    if (error instanceof GoogleApiError && (error.category === "permission" || (error.category === "upstream" && error.upstreamStatus !== null && error.upstreamStatus < 500))) throw new GoogleApiError("credentials", error.upstreamStatus);
    throw error;
  }
  if (!isRecord(value) || typeof value.access_token !== "string" || !/^[\x21-\x7e]{1,4096}$/u.test(value.access_token)
    || typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in) || value.expires_in < 60 || value.expires_in > 86_400
    || (typeof value.token_type === "string" && value.token_type.toLowerCase() !== "bearer")) {
    logAnalyticsFailure("token", "invalid-response");
    throw new GoogleApiError("invalid-response");
  }
  const lifetime = Math.max(60, value.expires_in - 300);
  tokenCache = { fingerprint: account.fingerprint, token: value.access_token, expiresAt: Date.now() + lifetime * 1000 };
  return value.access_token;
}

/** isolate 内で、期限の5分前まで同じ token を使う。同時の取得は1回にまとめる。 */
async function accessToken(account: ServiceAccount): Promise<string> {
  const cached = tokenCache;
  if (cached && cached.fingerprint === account.fingerprint && cached.expiresAt > Date.now()) return cached.token;
  const pending = tokenInFlight;
  if (pending && pending.fingerprint === account.fingerprint) return pending.promise;
  const promise: Promise<string> = requestToken(account).finally(() => { if (tokenInFlight?.promise === promise) tokenInFlight = null; });
  tokenInFlight = { fingerprint: account.fingerprint, promise };
  return promise;
}

export class GoogleAnalyticsClient {
  constructor(private readonly account: ServiceAccount) {}

  private async call(url: string, operation: GoogleOperation, body?: unknown): Promise<unknown> {
    const token = await accessToken(this.account);
    const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    try {
      return await boundedGoogleJson(url, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, operation);
    } catch (error) {
      // 失効した token は次の呼び出しで取り直す
      if (error instanceof GoogleApiError && error.upstreamStatus === 401 && tokenCache?.token === token) tokenCache = null;
      throw error;
    }
  }

  /** GA4 Admin: プロパティの時間帯。 */
  async ga4Property(propertyId: string): Promise<{ readonly timeZone: string }> {
    const value = await this.call(`${ADMIN_API}/properties/${propertyId}`, "ga4_property");
    if (!isRecord(value) || value.name !== `properties/${propertyId}` || !validTimeZone(value.timeZone)) return invalid("ga4_property");
    if (value.deleteTime !== undefined) throw new GoogleApiError("not-found");
    return { timeZone: value.timeZone as string };
  }

  /** GA4 Admin: プロパティの Web データストリーム（defaultUri の origin と測定ID）。 */
  async ga4WebStreams(propertyId: string): Promise<readonly Ga4WebStream[]> {
    const streams: Ga4WebStream[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const query = new URLSearchParams({ pageSize: "200", ...(pageToken ? { pageToken } : {}) });
      const value = await this.call(`${ADMIN_API}/properties/${propertyId}/dataStreams?${query}`, "ga4_streams");
      if (!isRecord(value) || (value.dataStreams !== undefined && (!Array.isArray(value.dataStreams) || value.dataStreams.length > 500))) return invalid("ga4_streams");
      for (const item of (value.dataStreams ?? []) as unknown[]) {
        if (!isRecord(item) || typeof item.name !== "string") return invalid("ga4_streams");
        const name = new RegExp(`^properties/${propertyId}/dataStreams/(\\d{1,20})$`, "u").exec(item.name);
        if (!name) return invalid("ga4_streams");
        if (item.type !== "WEB_DATA_STREAM" || !isRecord(item.webStreamData)) continue;
        const measurementId = item.webStreamData.measurementId, defaultUri = item.webStreamData.defaultUri;
        if (typeof measurementId !== "string" || !/^G-[A-Za-z0-9]{4,24}$/u.test(measurementId) || typeof defaultUri !== "string") continue;
        const origin = streamOrigin(defaultUri);
        if (origin) streams.push({ streamId: name[1]!, measurementId, origin });
      }
      if (typeof value.nextPageToken !== "string" || !value.nextPageToken) break;
      if (value.nextPageToken.length > 1024) return invalid("ga4_streams");
      pageToken = value.nextPageToken;
    }
    return streams;
  }

  async ga4RunReport(propertyId: string, request: Ga4ReportRequest): Promise<readonly Ga4Row[]> {
    const value = await this.call(`${DATA_API}/properties/${propertyId}:runReport`, "ga4_report", request);
    return parseGa4Rows(value, request);
  }

  /** Search Console: サービスアカウントの権限。URL-prefix の値は変えずに送る。 */
  async searchConsoleSite(siteUrl: string): Promise<{ readonly permissionLevel: string }> {
    const value = await this.call(`${SEARCH_CONSOLE_API}/sites/${encodeURIComponent(siteUrl)}`, "gsc_site");
    if (!isRecord(value) || value.siteUrl !== siteUrl || typeof value.permissionLevel !== "string" || value.permissionLevel.length > 64) return invalid("gsc_site");
    return { permissionLevel: value.permissionLevel };
  }

  /** Search Analytics の read-only query。dimension は date / page だけ（検索語の query dimension は使わない）。 */
  async searchConsoleQuery(siteUrl: string, request: SearchConsoleQuery): Promise<{ readonly rows: readonly SearchConsoleRow[] }> {
    const body = {
      startDate: request.startDate,
      endDate: request.endDate,
      dimensions: [...request.dimensions],
      type: "web",
      dataState: "final",
      rowLimit: request.rowLimit,
      startRow: 0
    };
    const value = await this.call(`${SEARCH_CONSOLE_API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, "gsc_query", body);
    return { rows: parseSearchConsoleRows(value, request) };
  }
}

function invalid(operation: GoogleOperation): never {
  logAnalyticsFailure(operation, "invalid-response");
  throw new GoogleApiError("invalid-response");
}

export function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 80) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}

export type Ga4WebStream = { readonly streamId: string; readonly measurementId: string; readonly origin: string };

/** ストリームの defaultUri の origin（https・認証情報なし）。path は origin の比較に使わない。 */
function streamOrigin(value: string): string | null {
  if (value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

// ---- GA4 Data API ----

type Ga4FilterExpression = Record<string, unknown>;
export type Ga4ReportRequest = {
  readonly dateRanges: readonly { readonly startDate: string; readonly endDate: string; readonly name: "current" | "previous" }[];
  readonly dimensions: readonly { readonly name: "date" | "sessionDefaultChannelGroup" | "pagePath" }[];
  readonly metrics: readonly { readonly name: "sessions" | "activeUsers" | "screenPageViews" }[];
  readonly dimensionFilter: { readonly andGroup: { readonly expressions: readonly Ga4FilterExpression[] } };
  readonly orderBys?: readonly Record<string, unknown>[];
  readonly limit: string;
  readonly keepEmptyRows: false;
};
type Ga4Row = { readonly dimensions: Readonly<Record<string, string>>; readonly metrics: Readonly<Record<string, number>> };

function parseGa4Rows(value: unknown, request: Ga4ReportRequest): readonly Ga4Row[] {
  if (!isRecord(value)) return invalid("ga4_report");
  const rows = value.rows;
  if (rows === undefined) return [];
  if (!Array.isArray(rows) || rows.length > 10_000 || !Array.isArray(value.dimensionHeaders) || !Array.isArray(value.metricHeaders)) return invalid("ga4_report");
  const allowedDimensions = new Set<string>([...request.dimensions.map((dimension) => dimension.name), "dateRange"]);
  const dimensionNames = value.dimensionHeaders.map((header) => isRecord(header) && typeof header.name === "string" && allowedDimensions.has(header.name) ? header.name : null);
  const metricNames = value.metricHeaders.map((header) => isRecord(header) && typeof header.name === "string" ? header.name : null);
  if (dimensionNames.includes(null) || metricNames.length !== request.metrics.length || request.metrics.some((metric, index) => metricNames[index] !== metric.name)) return invalid("ga4_report");
  return rows.map((row): Ga4Row => {
    if (!isRecord(row) || !Array.isArray(row.dimensionValues ?? []) || !Array.isArray(row.metricValues)) return invalid("ga4_report");
    const dimensionValues = (row.dimensionValues ?? []) as unknown[], metricValues = row.metricValues as unknown[];
    if (dimensionValues.length !== dimensionNames.length || metricValues.length !== metricNames.length) return invalid("ga4_report");
    const dimensions: Record<string, string> = {}, metrics: Record<string, number> = {};
    dimensionValues.forEach((item, index) => {
      if (!isRecord(item) || typeof item.value !== "string" || item.value.length > 2048) invalid("ga4_report");
      dimensions[dimensionNames[index]!] = (item as { value: string }).value;
    });
    metricValues.forEach((item, index) => {
      if (!isRecord(item) || typeof item.value !== "string" || !/^\d{1,15}$/u.test(item.value)) invalid("ga4_report");
      metrics[metricNames[index]!] = Number((item as { value: string }).value);
    });
    return { dimensions, metrics };
  });
}

export type Ga4Target = { readonly propertyId: string; readonly streamId: string; readonly hostName: string; readonly timeZone: string };

/** 必ず接続済み stream とサイトの host の両方で絞る（同じプロパティに別サイトが混ざっていても数えない）。 */
function siteFilter(target: Ga4Target, extra: readonly Ga4FilterExpression[] = []): Ga4ReportRequest["dimensionFilter"] {
  return { andGroup: { expressions: [
    { filter: { fieldName: "streamId", stringFilter: { matchType: "EXACT", value: target.streamId, caseSensitive: true } } },
    { filter: { fieldName: "hostName", stringFilter: { matchType: "EXACT", value: target.hostName, caseSensitive: false } } },
    ...extra
  ] } };
}

const GA4_CHANNEL_LABELS: Readonly<Record<string, string>> = {
  "Organic Search": "自然検索",
  Direct: "直接",
  Referral: "参照元サイト",
  "Organic Social": "ソーシャル",
  "Paid Search": "有料検索",
  Email: "メール",
  Unassigned: "不明"
};
const OTHER_CHANNEL = "その他";

function ga4Date(value: string | undefined): string | null {
  if (!value || !/^\d{8}$/u.test(value)) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}
function rangeOf(row: Ga4Row, single: boolean): "current" | "previous" | null {
  const value = row.dimensions.dateRange;
  if (value === undefined) return single ? "current" : null;
  return value === "current" || value === "previous" ? value : null;
}

/** プロパティの時間帯で昨日までの期間を、当期・直前期の2つの dateRanges で集計する。 */
export async function loadGa4Report(client: GoogleAnalyticsClient, target: Ga4Target, window: ReportWindow, fetchedAt: string): Promise<SourceResult<Ga4Report>> {
  const both = [
    { startDate: window.range.start, endDate: window.range.end, name: "current" as const },
    { startDate: window.previousRange.start, endDate: window.previousRange.end, name: "previous" as const }
  ];
  const current = [both[0]!], previous = [both[1]!];
  const [totals, daily, channels, pages] = await Promise.all([
    client.ga4RunReport(target.propertyId, { dateRanges: both, dimensions: [], metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "screenPageViews" }], dimensionFilter: siteFilter(target), limit: "10", keepEmptyRows: false }),
    client.ga4RunReport(target.propertyId, { dateRanges: current, dimensions: [{ name: "date" }], metrics: [{ name: "sessions" }], dimensionFilter: siteFilter(target), orderBys: [{ dimension: { dimensionName: "date" } }], limit: "400", keepEmptyRows: false }),
    client.ga4RunReport(target.propertyId, { dateRanges: both, dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: [{ name: "sessions" }], dimensionFilter: siteFilter(target), limit: "100", keepEmptyRows: false }),
    client.ga4RunReport(target.propertyId, { dateRanges: current, dimensions: [{ name: "pagePath" }], metrics: [{ name: "screenPageViews" }], dimensionFilter: siteFilter(target), orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }], limit: "100", keepEmptyRows: false })
  ]);

  const total = (range: "current" | "previous", metric: "sessions" | "activeUsers" | "screenPageViews") =>
    totals.filter((row) => rangeOf(row, false) === range).reduce((sum, row) => sum + (row.metrics[metric] ?? 0), 0);
  const metric = (name: "sessions" | "activeUsers" | "screenPageViews"): Metric => ({ current: total("current", name), previous: total("previous", name) });

  const sessionsByDate = new Map<string, number>();
  for (const row of daily) {
    const date = ga4Date(row.dimensions.date);
    if (!date || date < window.range.start || date > window.range.end) continue;
    sessionsByDate.set(date, (sessionsByDate.get(date) ?? 0) + (row.metrics.sessions ?? 0));
  }

  const sourceTotals = new Map<string, { current: number; previous: number }>();
  for (const row of channels) {
    const range = rangeOf(row, false);
    if (!range) continue;
    const name = GA4_CHANNEL_LABELS[row.dimensions.sessionDefaultChannelGroup ?? ""] ?? OTHER_CHANNEL;
    const entry = sourceTotals.get(name) ?? { current: 0, previous: 0 };
    entry[range] += row.metrics.sessions ?? 0;
    sourceTotals.set(name, entry);
  }
  const sources = [...sourceTotals].sort(([leftName, left], [rightName, right]) => right.current - left.current || right.previous - left.previous || leftName.localeCompare(rightName, "ja"))
    .slice(0, 30).map(([name, value]) => ({ name, sessions: { current: value.current, previous: value.previous } }));

  const topPages: { path: string; current: number }[] = [];
  for (const row of pages) {
    if (topPages.length >= TOP_PAGES) break;
    const path = safePath(row.dimensions.pagePath);
    if (path === null || topPages.some((page) => page.path === path)) continue;
    topPages.push({ path, current: row.metrics.screenPageViews ?? 0 });
  }
  const previousViews = new Map<string, number>();
  if (topPages.length) {
    const rows = await client.ga4RunReport(target.propertyId, {
      dateRanges: previous, dimensions: [{ name: "pagePath" }], metrics: [{ name: "screenPageViews" }],
      dimensionFilter: siteFilter(target, [{ filter: { fieldName: "pagePath", inListFilter: { values: topPages.map((page) => page.path), caseSensitive: true } } }]),
      limit: "100", keepEmptyRows: false
    });
    for (const row of rows) {
      const path = row.dimensions.pagePath;
      if (path !== undefined) previousViews.set(path, (previousViews.get(path) ?? 0) + (row.metrics.screenPageViews ?? 0));
    }
  }

  const update = { lastUpdatedAt: fetchedAt, dataThrough: window.range.end };
  if (!totals.length && !daily.length && !channels.length && !pages.length) return { state: "empty", metadata: { ...window, ...update } };
  return {
    state: "available",
    report: {
      ...window,
      sessions: metric("sessions"), activeUsers: metric("activeUsers"), pageViews: metric("screenPageViews"),
      daily: datesOf(window.range).map((date) => ({ date, sessions: sessionsByDate.get(date) ?? 0 })),
      sources,
      topPages: topPages.map((page) => ({ page: { path: page.path }, pageViews: { current: page.current, previous: previousViews.get(page.path) ?? 0 } }))
    },
    ...update
  };
}

function safePath(value: string | undefined): string | null {
  try { return parseAnalyticsPagePath(value); } catch { return null; }
}

// ---- Search Console ----

export type SearchConsoleQuery = {
  readonly startDate: string;
  readonly endDate: string;
  /** 検索語（query）は取得しない。 */
  readonly dimensions: readonly ("date" | "page")[];
  readonly rowLimit: number;
};
type SearchConsoleRow = { readonly keys: readonly string[]; readonly clicks: number; readonly impressions: number; readonly ctr: number | null; readonly position: number | null };

function parseSearchConsoleRows(value: unknown, request: SearchConsoleQuery): readonly SearchConsoleRow[] {
  if (!isRecord(value)) return invalid("gsc_query");
  if (value.rows === undefined) return [];
  if (!Array.isArray(value.rows) || value.rows.length > 25_000) return invalid("gsc_query");
  return value.rows.map((row): SearchConsoleRow => {
    if (!isRecord(row)) return invalid("gsc_query");
    const keys = row.keys ?? [];
    if (!Array.isArray(keys) || keys.length !== request.dimensions.length || keys.some((key) => typeof key !== "string" || key.length > 2048)) return invalid("gsc_query");
    const count = (input: unknown) => typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : invalid("gsc_query");
    const ratio = (input: unknown, maximum: number) => input === undefined || input === null ? null : typeof input === "number" && Number.isFinite(input) && input >= 0 && input <= maximum ? input : invalid("gsc_query");
    return { keys: keys as string[], clicks: count(row.clicks), impressions: count(row.impressions), ctr: ratio(row.ctr, 1), position: ratio(row.position, 10_000) };
  });
}

export type SearchConsoleTarget = { readonly siteUrl: string; readonly siteOrigin: string };

/** Pacific Time の final データ。合計（dimension なし）・日別・page 上位（サイトと同じ origin の行だけ）。 */
export async function loadSearchConsoleReport(client: GoogleAnalyticsClient, target: SearchConsoleTarget, window: ReportWindow, fetchedAt: string): Promise<SourceResult<SearchConsoleReport>> {
  const query = (range: LocalRange, dimensions: SearchConsoleQuery["dimensions"], rowLimit: number) =>
    client.searchConsoleQuery(target.siteUrl, { startDate: range.start, endDate: range.end, dimensions, rowLimit });
  // Search Analytics が返す履歴は16か月まで。直前期がそれより古い日を含む（12か月表示など）ときは、
  // 一部の日だけの値を比較値に見せないよう、直前期は取得せず未取得（null）にする
  const retentionStart = monthsBack(addDays(window.range.end, SEARCH_CONSOLE_FINAL_DELAY_DAYS), SEARCH_CONSOLE_RETENTION_MONTHS);
  const previousAvailable = window.previousRange.start >= retentionStart;
  const none = Promise.resolve({ rows: [] as readonly SearchConsoleRow[] });
  const [currentTotal, previousTotal, daily, currentPages, previousPages] = await Promise.all([
    query(window.range, [], 1),
    previousAvailable ? query(window.previousRange, [], 1) : none,
    query(window.range, ["date"], 400),
    query(window.range, ["page"], 100),
    previousAvailable ? query(window.previousRange, ["page"], SEARCH_CONSOLE_PREVIOUS_PAGE_ROWS) : none
  ]);
  const totalOf = (rows: readonly SearchConsoleRow[]) => rows[0] ?? null;
  const current = totalOf(currentTotal.rows), previous = totalOf(previousTotal.rows);
  const pair = (pick: (row: SearchConsoleRow | null) => number | null): Metric => ({ current: pick(current), previous: previousAvailable ? pick(previous) : null });
  const counted = (key: "clicks" | "impressions") => (row: SearchConsoleRow | null) => row ? row[key] : 0;
  const rated = (key: "ctr" | "position") => (row: SearchConsoleRow | null) => row && row.impressions > 0 ? row[key] : null;

  const byDate = new Map<string, SearchConsoleRow>();
  for (const row of daily.rows) {
    const date = row.keys[0];
    if (date && /^\d{4}-\d{2}-\d{2}$/u.test(date) && date >= window.range.start && date <= window.range.end) byDate.set(date, row);
  }
  const pathOf = (url: string | undefined): string | null => {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      if (parsed.origin !== target.siteOrigin || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
      return safePath(parsed.pathname);
    } catch { return null; }
  };
  const top: { path: string; clicks: number; impressions: number }[] = [];
  for (const row of currentPages.rows) {
    if (top.length >= TOP_PAGES) break;
    const path = pathOf(row.keys[0]);
    if (path === null || top.some((page) => page.path === path)) continue;
    top.push({ path, clicks: row.clicks, impressions: row.impressions });
  }
  const previousByPath = new Map<string, SearchConsoleRow>();
  for (const row of previousPages.rows) {
    const path = pathOf(row.keys[0]);
    if (path !== null && !previousByPath.has(path)) previousByPath.set(path, row);
  }
  // 直前期の page 行が上限まであるとき、無い行は 0 と断定できない
  const previousComplete = previousPages.rows.length < SEARCH_CONSOLE_PREVIOUS_PAGE_ROWS;
  const previousPage = (path: string, key: "clicks" | "impressions") => !previousAvailable ? null : previousByPath.get(path)?.[key] ?? (previousComplete ? 0 : null);

  const update = { lastUpdatedAt: fetchedAt, dataThrough: window.range.end };
  if (!currentTotal.rows.length && !previousTotal.rows.length && !daily.rows.length && !currentPages.rows.length && !previousPages.rows.length) {
    return { state: "empty", metadata: { ...window, ...update } };
  }
  return {
    state: "available",
    report: {
      ...window,
      clicks: pair(counted("clicks")), impressions: pair(counted("impressions")), ctr: pair(rated("ctr")), averagePosition: pair(rated("position")),
      daily: datesOf(window.range).map((date) => ({ date, clicks: byDate.get(date)?.clicks ?? 0, impressions: byDate.get(date)?.impressions ?? 0 })),
      topPages: top.map((page) => ({ page: { path: page.path }, clicks: { current: page.clicks, previous: previousPage(page.path, "clicks") }, impressions: { current: page.impressions, previous: previousPage(page.path, "impressions") } }))
    },
    ...update
  };
}

// ---- 期間 ----

function pad(value: number): string { return String(value).padStart(2, "0"); }

/** その時間帯での今日の日付（YYYY-MM-DD）。 */
export function localDate(now: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function monthsBack(end: string, months: number): string {
  const [year, month, day] = end.split("-").map(Number) as [number, number, number];
  let targetYear = year, targetMonth = month - months;
  while (targetMonth < 1) { targetMonth += 12; targetYear -= 1; }
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return addDays(`${String(targetYear).padStart(4, "0")}-${pad(targetMonth)}-${pad(Math.min(day, lastDay))}`, 1);
}

function dayCount(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
}

/** 7日・28日はちょうどその日数、3か月・12か月は暦の月で数え、直前期は同じ長さで連続させる。 */
export function analyticsWindow(period: AnalyticsPeriod, end: string, timeZone: string): ReportWindow {
  let start = period === "7d" ? addDays(end, -6) : period === "28d" ? addDays(end, -27) : monthsBack(end, period === "3m" ? 3 : 12);
  const [minimum, maximum] = period === "3m" ? [89, 92] : period === "12m" ? [365, 366] : [0, Infinity];
  const length = dayCount(start, end);
  if (length < minimum || length > maximum) start = addDays(end, -((period === "3m" ? 90 : 365) - 1));
  const days = dayCount(start, end);
  const previousEnd = addDays(start, -1);
  return {
    range: { start, end, timezone: timeZone },
    previousRange: { start: addDays(previousEnd, -(days - 1)), end: previousEnd, timezone: timeZone }
  };
}

/** GA4 はプロパティの時間帯で昨日まで。 */
export function ga4Window(period: AnalyticsPeriod, timeZone: string, now: number): ReportWindow {
  return analyticsWindow(period, addDays(localDate(now, timeZone), -1), timeZone);
}

/** Search Console は Pacific Time の今日から3日前まで（final データ）。 */
export function searchConsoleWindow(period: AnalyticsPeriod, now: number): ReportWindow {
  return analyticsWindow(period, addDays(localDate(now, SEARCH_CONSOLE_TIME_ZONE), -SEARCH_CONSOLE_FINAL_DELAY_DAYS), SEARCH_CONSOLE_TIME_ZONE);
}

function datesOf(range: LocalRange): string[] {
  const dates: string[] = [];
  for (let date = range.start; date <= range.end && dates.length < 371; date = addDays(date, 1)) dates.push(date);
  return dates;
}

/** その日の時間帯の UTC offset（+09:00 など）。 */
export function zoneOffset(date: string, timeZone: string): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(new Date(`${date}T12:00:00.000Z`))
    .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/u.exec(name);
  if (!match || !match[1]) return "+00:00";
  return `${match[1]}${match[2]}:${match[3]}`;
}

// ---- 計測タグ ----

/** サイトの "/" を redirect なし・短い timeout・サイズ上限で読み、保存済みの測定IDが HTML にあるかだけを見る。 */
export async function detectTrackingTag(origin: string, measurementId: string): Promise<"published" | "not-configured" | "failed"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITE_HTML_TIMEOUT_MILLISECONDS);
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
    const mediaType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (response.status !== 200 || response.redirected || mediaType !== "text/html") {
      await response.body?.cancel().catch(() => undefined);
      logAnalyticsFailure("site_html", response.status >= 300 && response.status < 400 ? "redirect" : "upstream", response.status || null);
      return "failed";
    }
    // 大きいページは先頭の上限までで判定する（計測タグは通常 head にある）
    const { text } = await readBoundedText(response, MAX_SITE_HTML_BYTES);
    const escaped = measurementId.replace(/[^A-Za-z0-9-]/gu, "");
    return new RegExp(`(^|[^A-Za-z0-9-])${escaped}(?![A-Za-z0-9])`, "u").test(text) ? "published" : "not-configured";
  } catch {
    logAnalyticsFailure("site_html", controller.signal.aborted ? "timeout" : "network");
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}
