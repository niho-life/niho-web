import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parseSiteAnalyticsSnapshot } from "@niho/web/analytics-data";
import { parseSiteAnalyticsChangePlan, parseSiteAnalyticsConnection } from "@niho/web/site-analytics";
import { parseProjectDashboardResult } from "@niho/web/project-read-model";

// Studio Worker のサイト分析ホスト（GA4 / Search Console）。Google は fetch の mock、D1 は node:sqlite と実 migration。
// ID・メール・鍵・origin はすべて架空。
const { DatabaseSync } = await import("node:sqlite").catch(() => ({}));
const testWithD1 = DatabaseSync ? test : test.skip;
const STUDIO = "https://studio.example";
const SHARED = "https://sites.example";
const ALPHA = "https://www.alpha.example";
const BETA = "https://beta.example";
const OWNER = "analytics-owner", EDITOR = "analytics-editor", OUTSIDER = "analytics-outsider";
const SA_EMAIL = "studio-analytics@fixture.invalid";
const ACCESS_TOKEN = "fixture-google-access-token";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = ["https://www.googleapis.com/auth/analytics.readonly", "https://www.googleapis.com/auth/webmasters.readonly"];
const PROPERTY = "100200300";

const migrationDirectory = new URL("../studio/migrations/", import.meta.url);
const migrations = await Promise.all((await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort().map((name) => readFile(new URL(name, migrationDirectory), "utf8")));
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../studio/worker.ts", import.meta.url))], bundle: true, format: "esm", platform: "node", target: "node22", write: false,
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(`${process.cwd()}/studio-worker-test.mjs`);' }
});
const worker = (await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`)).default;
const access = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...access.publicKey.export({ format: "jwk" }), kid: "analytics-test", alg: "RS256", use: "sig" };
const google = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY = google.privateKey.export({ type: "pkcs8", format: "pem" });
const SA_JSON = JSON.stringify({ type: "service_account", project_id: "fixture-project", private_key_id: "fixturekey01", private_key: PRIVATE_KEY, client_email: SA_EMAIL, token_uri: TOKEN_URL });

const localDate = (timeZone) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addDays = (date, days) => { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); };
const days = (range) => (Date.parse(range.end) - Date.parse(range.start)) / 86_400_000 + 1;
const gjson = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=UTF-8" } });
const web = (id, measurementId, defaultUri) => ({ name: `properties/${PROPERTY}/dataStreams/${id}`, type: "WEB_DATA_STREAM", webStreamData: { measurementId, defaultUri } });
const streamOf = (property, id, measurementId, defaultUri) => ({ ...web(id, measurementId, defaultUri), name: `properties/${property}/dataStreams/${id}` });
const tagHtml = (id) => `<!doctype html><html><head><script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script></head><body>fixture</body></html>`;

function googleState() {
  return {
    properties: {
      [PROPERTY]: { timeZone: "Asia/Tokyo", streams: [web(11, "G-ALPHA0001", `${ALPHA}/`), web(22, "G-BETA00002", BETA), { name: `properties/${PROPERTY}/dataStreams/33`, type: "ANDROID_APP_DATA_STREAM", androidAppStreamData: { packageName: "example.fixture" } }] },
      200300400: { timeZone: "Asia/Tokyo", streams: [streamOf("200300400", 31, "G-OTHER0001", "https://other.example")] },
      300400500: { timeZone: "Asia/Tokyo", streams: [streamOf("300400500", 41, "G-DUPA00001", ALPHA), streamOf("300400500", 42, "G-DUPB00002", `${ALPHA}/blog`)] },
      400500600: { timeZone: "Asia/Tokyo", streams: [streamOf("400500600", 51, "G-HTTP00001", "http://www.alpha.example"), streamOf("400500600", 52, "G-NOWWW0001", "https://alpha.example")] }
    },
    // GA4 側は stream と hostName ごとにデータを持つ（filter が無ければ別サイトの値が混ざる）
    ga4Data: {
      "11|www.alpha.example": {
        totals: { current: { sessions: 120, activeUsers: 90, screenPageViews: 300 }, previous: { sessions: 100, activeUsers: 80, screenPageViews: 250 } },
        channels: { "Organic Search": [70, 60], Direct: [30, 25], "Paid Other": [12, 10], Display: [8, 5] },
        pages: [["/", 200, 150], ["/rooms", 80, 0], ["/%E6%97%A5", 20, 1]]
      },
      "22|beta.example": {
        totals: { current: { sessions: 999, activeUsers: 888, screenPageViews: 777 }, previous: { sessions: 9, activeUsers: 8, screenPageViews: 7 } },
        channels: { Direct: [999, 9] },
        pages: [["/beta-only", 777, 7]]
      }
    },
    gscPermissions: { [`${ALPHA}/`]: "siteFullUser", [`${BETA}/`]: "siteOwner" },
    gscData: {
      [`${ALPHA}/`]: {
        current: { clicks: 40, impressions: 1000, ctr: 0.04, position: 7.25 }, previous: null,
        pages: [[`${ALPHA}/`, 30, 600], ["https://other.example/leak", 50, 900], [`${ALPHA}/rooms?ref=x`, 5, 50], [`${ALPHA}/%E6%97%A5`, 3, 30], [`${ALPHA}/rooms`, 10, 400]],
        previousPages: [[`${ALPHA}/`, 12, 300]]
      }
    },
    html: { [ALPHA]: { status: 200, body: tagHtml("G-ALPHA0001") } },
    fail: { admin: null, ga4Report: null, gscSite: null, gscQuery: null },
    // runReport の応答を返す直前に呼ぶ（ほかの要求が同時に状態を書いた場合を再現する）
    onRunReport: null
  };
}

async function fixture(t, options = {}) {
  const issuer = `https://access-${crypto.randomUUID()}.example`, audience = "analytics-test";
  const now = Math.floor(Date.now() / 1000), encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = (claims) => {
    const input = `${encode({ alg: "RS256", kid: jwk.kid, typ: "JWT" })}.${encode({ iss: issuer, aud: audience, exp: now + 600, iat: now, type: "app", ...claims })}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), access.privateKey).toString("base64url")}`;
  };
  const tokens = { [OWNER]: jwt({ sub: OWNER, email: "owner@example.test" }), [EDITOR]: jwt({ sub: EDITOR, email: "editor@example.test" }), [OUTSIDER]: jwt({ sub: OUTSIDER, email: "outsider@example.test" }) };
  const state = googleState(), calls = { token: 0, admin: [], runReport: [], gsc: [], html: 0 };
  const gscEnd = addDays(localDate("America/Los_Angeles"), -3);
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.href === `${issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    if (url.href === TOKEN_URL) {
      assert.equal(init.method, "POST"); assert.equal(init.redirect, "manual");
      const params = new URLSearchParams(init.body);
      assert.equal(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const [header, claims, signature] = params.get("assertion").split(".");
      assert.ok(verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), google.publicKey, Buffer.from(signature, "base64url")), "RS256 で署名する");
      const parsed = JSON.parse(Buffer.from(claims, "base64url"));
      assert.equal(parsed.iss, SA_EMAIL); assert.equal(parsed.aud, TOKEN_URL);
      assert.deepEqual(parsed.scope.split(" ").sort(), [...SCOPES].sort(), "scope は読み取り2つだけ");
      calls.token += 1;
      return gjson({ access_token: ACCESS_TOKEN, expires_in: 3600, token_type: "Bearer" });
    }
    if (["https://analyticsadmin.googleapis.com", "https://analyticsdata.googleapis.com", "https://www.googleapis.com"].includes(url.origin)) {
      assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${ACCESS_TOKEN}`);
      assert.equal(init.redirect, "manual");
    }
    const failWith = (status) => gjson({ error: { code: status, status: status === 429 ? "RESOURCE_EXHAUSTED" : status === 404 ? "NOT_FOUND" : "PERMISSION_DENIED", message: "fixture upstream detail" } }, status);
    if (url.origin === "https://analyticsadmin.googleapis.com") {
      calls.admin.push(url.pathname);
      if (state.fail.admin) return failWith(state.fail.admin);
      const property = /^\/v1beta\/properties\/(\d+)$/u.exec(url.pathname), streams = /^\/v1beta\/properties\/(\d+)\/dataStreams$/u.exec(url.pathname);
      const id = (property ?? streams)?.[1], fixtureProperty = state.properties[id];
      if (!fixtureProperty) return failWith(404);
      if (property) return gjson({ name: `properties/${id}`, displayName: "fixture", timeZone: fixtureProperty.timeZone, currencyCode: "JPY" });
      return gjson({ dataStreams: fixtureProperty.streams });
    }
    if (url.origin === "https://analyticsdata.googleapis.com") {
      const match = /^\/v1beta\/properties\/(\d+):runReport$/u.exec(url.pathname);
      assert.ok(match, url.pathname);
      const body = JSON.parse(init.body);
      calls.runReport.push({ propertyId: match[1], body });
      if (state.onRunReport) state.onRunReport();
      if (state.fail.ga4Report) return state.fail.ga4Report === 302 ? new Response(null, { status: 302, headers: { Location: "https://evil.example/" } }) : failWith(state.fail.ga4Report);
      return runReport(state, body);
    }
    if (url.origin === "https://www.googleapis.com") {
      const query = /^\/webmasters\/v3\/sites\/([^/]+)\/searchAnalytics\/query$/u.exec(url.pathname), site = /^\/webmasters\/v3\/sites\/([^/]+)$/u.exec(url.pathname);
      const siteUrl = decodeURIComponent((query ?? site)[1]);
      if (site) {
        if (state.fail.gscSite) return failWith(state.fail.gscSite);
        const permissionLevel = state.gscPermissions[siteUrl];
        return permissionLevel ? gjson({ siteUrl, permissionLevel }) : failWith(404);
      }
      const body = JSON.parse(init.body);
      calls.gsc.push({ siteUrl, body });
      if (state.fail.gscQuery) return failWith(state.fail.gscQuery);
      return searchConsole(state, siteUrl, body, gscEnd);
    }
    const html = state.html[url.origin];
    if (html && url.pathname === "/") {
      calls.html += 1;
      assert.equal(init.redirect, "manual"); assert.equal(init.credentials, "omit");
      return new Response(html.body, { status: html.status, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if ([BETA].includes(url.origin)) return new Response("not found", { status: 404, headers: { "Content-Type": "text/html" } });
    throw new Error(`unexpected fetch ${url}`);
  });
  const logs = [];
  t.mock.method(console, "warn", (...args) => { logs.push(args); });

  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  for (const migration of migrations) sqlite.exec(migration);
  sqlite.exec(`
    INSERT INTO projects (id, name) VALUES ('project-alpha', 'Alpha（架空）'), ('project-beta', 'Beta（架空）'), ('project-managed', 'Managed（架空）'), ('project-none', 'None（架空）');
    INSERT INTO sites (id, project_id, name, public_origin) VALUES
      ('site-alpha', 'project-alpha', 'Alpha site', '${ALPHA}'), ('site-beta', 'project-beta', 'Beta site', '${BETA}'),
      ('site-managed', 'project-managed', 'Managed site', NULL), ('site-none', 'project-none', 'None site', NULL);
    INSERT INTO managed_sites (site_id, slug, created_by_subject) VALUES ('site-managed', 'managed-fixture', '${OWNER}');
    INSERT INTO project_members (project_id, access_subject, role, display_name, email) VALUES
      ('project-alpha', '${OWNER}', 'owner', 'Owner', 'owner@example.test'),
      ('project-alpha', '${EDITOR}', 'editor', 'Editor', 'editor@example.test'),
      ('project-beta', '${OWNER}', 'owner', 'Owner', 'owner@example.test'),
      ('project-beta', '${OUTSIDER}', 'owner', 'Outsider', 'outsider@example.test'),
      ('project-managed', '${OWNER}', 'owner', 'Owner', 'owner@example.test'),
      ('project-none', '${OWNER}', 'owner', 'Owner', 'owner@example.test');
  `);
  const wrap = (query) => {
    const statement = sqlite.prepare(query);
    let params = [];
    return {
      bind(...values) { params = values; return this; },
      async first() { return statement.get(...params) ?? null; },
      execute() {
        if (/^\s*(?:UPDATE|INSERT|DELETE)\b/u.test(query)) return { success: true, meta: statement.run(...params) };
        return { success: true, results: statement.all(...params) };
      },
      async all() { return this.execute(); }
    };
  };
  const env = {
    ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience, PUBLIC_SITES_ORIGIN: SHARED,
    ...(options.secret === undefined ? { STUDIO_ANALYTICS_GOOGLE_SA_JSON: SA_JSON } : options.secret === null ? {} : { STUDIO_ANALYTICS_GOOGLE_SA_JSON: options.secret }),
    DB: { prepare: wrap, async batch(statements) {
      sqlite.exec("BEGIN");
      try { const result = statements.map((statement) => statement.execute()); sqlite.exec("COMMIT"); return result; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    } },
    ASSETS: { async fetch() { return new Response("unused"); } },
    KAMAKURA_SITE: { async fetch() { throw new Error("Kamakura must not be called"); } }
  };
  const send = (method, path, body, options = {}) => {
    const headers = new Headers({ "Cf-Access-Jwt-Assertion": tokens[options.as ?? OWNER] });
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      if (options.sameOrigin !== false) { headers.set("Origin", STUDIO); headers.set("Sec-Fetch-Site", "same-origin"); }
    }
    return worker.fetch(new Request(`${STUDIO}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  };
  const count = (table, where = "1 = 1", ...values) => sqlite.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${where}`).get(...values).count;
  return { sqlite, state, calls, logs, send, count, gscEnd, ga4End: addDays(localDate("Asia/Tokyo"), -1) };
}

function runReport(state, body) {
  const expressions = body.dimensionFilter?.andGroup?.expressions ?? [];
  const field = (name) => expressions.find((expression) => expression.filter?.fieldName === name)?.filter;
  const data = state.ga4Data[`${field("streamId")?.stringFilter?.value}|${field("hostName")?.stringFilter?.value}`];
  const inList = field("pagePath")?.inListFilter?.values;
  const dimensions = body.dimensions.map((dimension) => dimension.name), multi = body.dateRanges.length > 1;
  const rows = [];
  if (data) for (const range of body.dateRanges) {
    const add = (values, metrics) => rows.push({ dimensionValues: [...values, ...(multi ? [range.name] : [])].map((value) => ({ value })), metricValues: metrics.map((value) => ({ value: String(value) })) });
    if (!dimensions.length) add([], body.metrics.map((metric) => data.totals[range.name][metric.name]));
    else if (dimensions[0] === "date") { add([range.startDate.replaceAll("-", "")], [3]); add([range.endDate.replaceAll("-", "")], [5]); }
    else if (dimensions[0] === "sessionDefaultChannelGroup") for (const [channel, values] of Object.entries(data.channels)) add([channel], [values[range.name === "current" ? 0 : 1]]);
    else for (const [path, current, previous] of data.pages) { const value = range.name === "current" ? current : previous; if (value > 0 && (!inList || inList.includes(path))) add([path], [value]); }
  }
  return gjson({ dimensionHeaders: [...dimensions, ...(multi ? ["dateRange"] : [])].map((name) => ({ name })), metricHeaders: body.metrics.map((metric) => ({ name: metric.name, type: "TYPE_INTEGER" })), ...(rows.length ? { rows } : {}), rowCount: rows.length, kind: "analyticsData#runReport" });
}

function searchConsole(state, siteUrl, body, gscEnd) {
  const data = state.gscData[siteUrl], current = body.endDate === gscEnd, rows = [];
  if (data) {
    if (!body.dimensions.length) { const total = current ? data.current : data.previous; if (total) rows.push({ ...total }); }
    else if (body.dimensions[0] === "date") rows.push({ keys: [body.startDate], clicks: 2, impressions: 50, ctr: 0.04, position: 8 }, { keys: [body.endDate], clicks: 4, impressions: 70, ctr: 0.0571, position: 6.5 });
    else for (const [url, clicks, impressions] of current ? data.pages : data.previousPages) rows.push({ keys: [url], clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: 5 });
  }
  return gjson({ ...(rows.length ? { rows } : {}), responseAggregationType: "byPage" });
}

async function body(response, status) {
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}
const api = (project = "project-alpha", site = "site-alpha") => `/api/projects/${project}/sites/${site}/analytics`;
const target = (project = "project-alpha", site = "site-alpha", siteOrigin = ALPHA) => ({ projectId: project, siteId: site, siteOrigin });
async function connectGa4(h, project = "project-alpha", site = "site-alpha") {
  const plan = await body(await h.send("POST", `${api(project, site)}/ga4/reporting/prepare`, { propertyId: PROPERTY }), 200);
  await body(await h.send("POST", `${api(project, site)}/ga4/reporting/apply`, { confirmationToken: plan.confirmationToken }), 200);
  return plan;
}
async function connectSearchConsole(h, project = "project-alpha", site = "site-alpha", origin = ALPHA) {
  const plan = await body(await h.send("POST", `${api(project, site)}/search-console/reporting/prepare`, { property: { kind: "url-prefix", value: `${origin}/` } }), 200);
  await body(await h.send("POST", `${api(project, site)}/search-console/reporting/apply`, { confirmationToken: plan.confirmationToken }), 200);
}
async function report(h, period = "28d", options = {}, project = "project-alpha", site = "site-alpha") {
  const value = await body(await h.send("GET", `${api(project, site)}/report?period=${period}`, undefined, options), 200);
  // 返す snapshot は閲覧契約の parser をそのまま通る
  assert.deepEqual(parseSiteAnalyticsSnapshot(value, { projectId: project, siteId: site, period }), value);
  return value;
}
function assertQuietLogs(logs) {
  for (const [label, detail] of logs) {
    assert.equal(label, "NIHO Studio analytics failure");
    for (const key of Object.keys(detail)) assert.ok(["operation", "category", "upstreamStatus"].includes(key), key);
    const text = JSON.stringify(detail);
    for (const forbidden of [ACCESS_TOKEN, SA_EMAIL, "PRIVATE KEY", PRIVATE_KEY.split("\n")[1], "fixture upstream detail", PROPERTY, ALPHA, OWNER]) assert.equal(text.includes(forbidden), false, forbidden);
  }
}

testWithD1("owner connects GA4 and Search Console, and the report is site-scoped, cached and valid", async (t) => {
  const h = await fixture(t);
  const tokenCallsBefore = h.calls.token;
  // 接続前: どちらも未接続（Google は呼ばない）
  const empty = await report(h);
  assert.deepEqual([empty.ga4, empty.searchConsole], [{ state: "not-connected" }, { state: "not-connected" }]);
  assert.equal(h.calls.runReport.length + h.calls.gsc.length, 0);

  const plan = await body(await h.send("POST", `${api()}/ga4/reporting/prepare`, { propertyId: PROPERTY }), 200);
  assert.deepEqual(parseSiteAnalyticsChangePlan(plan, target()).target, target());
  assert.equal(plan.action, "connect-ga4"); assert.equal(plan.publicOrigin, ALPHA);
  assert.deepEqual(plan.changes.map((change) => [change.label, change.currentValue, change.nextValue]), [["GA4プロパティID", null, PROPERTY], ["測定ID", null, "G-ALPHA0001"], ["時間帯", null, "Asia/Tokyo"]]);
  // D1 には token の hash だけ。有効期限は2分
  const stored = h.sqlite.prepare("SELECT * FROM site_analytics_plans").get();
  assert.equal(stored.token_hash, createHash("sha256").update(plan.confirmationToken).digest("hex"));
  assert.equal(JSON.stringify(stored).includes(plan.confirmationToken), false);
  assert.equal(stored.expires_at - stored.created_at, 120); assert.equal(stored.connection_version, 0); assert.equal(stored.actor_subject, OWNER);
  assert.ok(Math.abs(Date.parse(plan.expiresAt) - Date.now() - 120_000) < 5_000);
  // prepare だけでは接続しない
  assert.equal((await body(await h.send("GET", `${api()}/connection`), 200)).ga4.reportingState, "not-connected");
  await body(await h.send("POST", `${api()}/ga4/reporting/apply`, { confirmationToken: plan.confirmationToken }), 200);
  assert.equal(h.count("site_analytics_plans"), 0, "apply で消費する");
  assert.equal(h.calls.html, 1, "接続時に計測タグを確かめる");

  await connectSearchConsole(h);
  const connection = await body(await h.send("GET", `${api()}/connection`), 200);
  assert.deepEqual(parseSiteAnalyticsConnection(connection, target()), connection);
  assert.deepEqual(connection, {
    target: target(),
    ga4: { measurementId: "G-ALPHA0001", trackingTagState: "published", propertyId: PROPERTY, reportingState: "connected", propertyTimeZone: "Asia/Tokyo", lastSyncedAt: null },
    searchConsole: { property: { kind: "url-prefix", value: `${ALPHA}/` }, ownershipState: "not-verified", verificationMethod: null, reportingState: "connected", lastSyncedAt: null }
  });
  const row = h.sqlite.prepare("SELECT * FROM site_analytics_connections WHERE site_id = 'site-alpha'").get();
  assert.equal(row.version, 2); assert.equal(row.ga4_stream_id, "11"); assert.equal(row.ga4_stream_origin, ALPHA); assert.equal(row.updated_by_subject, OWNER);

  const value = await report(h);
  assert.equal(value.ga4.state, "available");
  const ga4 = value.ga4.report;
  assert.deepEqual(ga4.range, { start: addDays(h.ga4End, -27), end: h.ga4End, timezone: "Asia/Tokyo" });
  assert.deepEqual(ga4.previousRange, { start: addDays(h.ga4End, -55), end: addDays(h.ga4End, -28), timezone: "Asia/Tokyo" });
  assert.deepEqual([ga4.sessions, ga4.activeUsers, ga4.pageViews], [{ current: 120, previous: 100 }, { current: 90, previous: 80 }, { current: 300, previous: 250 }]);
  assert.equal(ga4.daily.length, 28);
  assert.deepEqual([ga4.daily[0], ga4.daily[1], ga4.daily[27]], [{ date: ga4.range.start, sessions: 3 }, { date: addDays(ga4.range.start, 1), sessions: 0 }, { date: h.ga4End, sessions: 5 }]);
  assert.deepEqual(ga4.sources, [{ name: "自然検索", sessions: { current: 70, previous: 60 } }, { name: "直接", sessions: { current: 30, previous: 25 } }, { name: "その他", sessions: { current: 20, previous: 15 } }]);
  // percent encoding の path は捨て、直前期に行が無いページは 0（実測）
  assert.deepEqual(ga4.topPages, [{ page: { path: "/" }, pageViews: { current: 200, previous: 150 } }, { page: { path: "/rooms" }, pageViews: { current: 80, previous: 0 } }]);
  assert.equal(value.ga4.dataThrough, h.ga4End);

  assert.equal(value.searchConsole.state, "available");
  const gsc = value.searchConsole.report;
  assert.deepEqual(gsc.range, { start: addDays(h.gscEnd, -27), end: h.gscEnd, timezone: "America/Los_Angeles" });
  // 直前期は行が無い: 件数は 0、比率と順位は未取得の null
  assert.deepEqual([gsc.clicks, gsc.impressions, gsc.ctr, gsc.averagePosition], [{ current: 40, previous: 0 }, { current: 1000, previous: 0 }, { current: 0.04, previous: null }, { current: 7.25, previous: null }]);
  assert.equal(gsc.daily.length, 28);
  assert.deepEqual(gsc.topPages, [
    { page: { path: "/" }, clicks: { current: 30, previous: 12 }, impressions: { current: 600, previous: 300 } },
    { page: { path: "/rooms" }, clicks: { current: 10, previous: 0 }, impressions: { current: 400, previous: 0 } }
  ], "別 origin・query 付き・percent encoding の行は返さない");
  assert.equal(JSON.stringify(value).includes("other.example"), false);

  // (f) runReport は必ず接続済み stream とサイトの host で絞る。Search Console は date / page だけ・final
  assert.ok(h.calls.runReport.length >= 5);
  for (const { propertyId, body: request } of h.calls.runReport) {
    assert.equal(propertyId, PROPERTY);
    const filters = request.dimensionFilter.andGroup.expressions.map((expression) => expression.filter);
    assert.deepEqual(filters.find((filter) => filter.fieldName === "streamId").stringFilter, { matchType: "EXACT", value: "11", caseSensitive: true });
    assert.deepEqual(filters.find((filter) => filter.fieldName === "hostName").stringFilter, { matchType: "EXACT", value: "www.alpha.example", caseSensitive: false });
  }
  assert.ok(h.calls.gsc.length >= 5);
  for (const { siteUrl, body: request } of h.calls.gsc) {
    assert.equal(siteUrl, `${ALPHA}/`);
    assert.equal(request.dataState, "final"); assert.equal(request.type, "web");
    assert.ok(request.dimensions.every((dimension) => dimension === "date" || dimension === "page"), JSON.stringify(request.dimensions));
    assert.equal(JSON.stringify(request).includes("query"), false, "検索語の query dimension を送らない");
  }

  // 2回目は cache（Google を呼ばない）。cache は正規化済みの集計だけで、生の応答・token を持たない
  const google = h.calls.runReport.length + h.calls.gsc.length;
  assert.deepEqual(await report(h), value);
  assert.equal(h.calls.runReport.length + h.calls.gsc.length, google);
  const cached = h.sqlite.prepare("SELECT * FROM site_analytics_cache ORDER BY source").all();
  assert.deepEqual(cached.map((entry) => [entry.site_id, entry.source, entry.period, entry.connection_version]), [["site-alpha", "ga4", "28d", 2], ["site-alpha", "search-console", "28d", 2]]);
  for (const entry of cached) {
    assert.ok(entry.expires_at - entry.fetched_at <= 1800);
    for (const raw of ["dimensionHeaders", "metricValues", "\"keys\"", ACCESS_TOKEN, "other.example", "%E6"]) assert.equal(entry.result_json.includes(raw), false, raw);
  }
  // 期間ルール: 7日はちょうど、3か月は 89〜92日、12か月は 365〜366日。直前期は同じ長さで連続
  for (const [period, minimum, maximum] of [["7d", 7, 7], ["3m", 89, 92], ["12m", 365, 366]]) {
    const result = await report(h, period);
    for (const source of [result.ga4.report, result.searchConsole.report]) {
      assert.ok(days(source.range) >= minimum && days(source.range) <= maximum, `${period} ${days(source.range)}`);
      assert.equal(days(source.previousRange), days(source.range)); assert.equal(addDays(source.previousRange.end, 1), source.range.start);
    }
  }

  // Dashboard の要約は GA4 28日の cache を使う（Google を呼ばない）。指標名は activeUsers / pageViews
  const reportsBefore = h.calls.runReport.length;
  const dashboard = await body(await h.send("GET", "/api/projects/project-alpha/sites/site-alpha/dashboard"), 200);
  assert.equal(h.calls.runReport.length, reportsBefore);
  assert.equal(dashboard.analytics.status, "ready");
  assert.equal(dashboard.analytics.data.activeUsers, 90); assert.equal(dashboard.analytics.data.pageViews, 300);
  assert.equal(dashboard.analytics.data.period.start, `${ga4.range.start}T00:00:00+09:00`);
  assert.equal(dashboard.analytics.data.period.end, `${h.ga4End}T23:59:59+09:00`);
  const project = { id: "project-alpha", name: "Alpha（架空）", site: { id: "site-alpha", name: "Alpha site", domains: [ALPHA] }, members: [{ userId: OWNER, displayName: "Owner" }] };
  assert.equal(parseProjectDashboardResult(dashboard, project).analytics.data.activeUsers, 90);
  // isolate 内の token cache: Google を何度呼んでも token の取得は高々1回
  assert.ok(h.calls.token - tokenCallsBefore <= 1);

  // (j) 片方の失敗はもう片方に影響させない
  h.sqlite.exec("DELETE FROM site_analytics_cache");
  h.state.fail.ga4Report = 500;
  const partial = await report(h);
  assert.deepEqual(partial.ga4, { state: "failed" });
  assert.equal(partial.searchConsole.state, "available");
  assert.equal((await body(await h.send("GET", `${api()}/connection`), 200)).ga4.reportingState, "connected", "一時的な失敗で接続状態を変えない");
  h.state.fail.ga4Report = 302;
  assert.deepEqual((await report(h, "7d")).ga4, { state: "failed" }, "redirect は追わない");
  h.state.fail.ga4Report = null;
  h.sqlite.exec("DELETE FROM site_analytics_cache");
  h.state.fail.gscQuery = 429;
  const quota = await report(h);
  assert.equal(quota.ga4.state, "available"); assert.deepEqual(quota.searchConsole, { state: "failed" });
  assert.equal((await body(await h.send("GET", `${api()}/connection`), 200)).searchConsole.reportingState, "quota-limited");
  h.state.fail.gscQuery = null;
  await body(await h.send("POST", `${api()}/search-console/reporting/retry`, {}), 200);
  const recovered = await body(await h.send("GET", `${api()}/connection`), 200);
  assert.equal(recovered.searchConsole.reportingState, "connected"); assert.match(recovered.searchConsole.lastSyncedAt, /Z$/u);
  assertQuietLogs(h.logs);
});

testWithD1("streams, properties and origins that do not exactly match D1 are never connected", async (t) => {
  const h = await fixture(t);
  const prepareGa4 = (propertyId) => h.send("POST", `${api()}/ga4/reporting/prepare`, { propertyId });
  // (b) 別 origin・同じ origin のストリームが2つ・http・www 違いは不一致。権限の無いプロパティは権限が必要
  for (const propertyId of ["200300400", "300400500", "400500600"]) assert.deepEqual(await body(await prepareGa4(propertyId), 409), { error: "property_mismatch" }, propertyId);
  assert.deepEqual(await body(await prepareGa4("987654321"), 409), { error: "permission_required" });
  h.state.fail.admin = 403;
  assert.deepEqual(await body(await prepareGa4(PROPERTY), 409), { error: "permission_required" });
  h.state.fail.admin = 429;
  assert.deepEqual(await body(await prepareGa4(PROPERTY), 429), { error: "quota_limited" });
  h.state.fail.admin = null;
  for (const input of [{ propertyId: "G-ALPHA0001" }, { propertyId: "12" }, { propertyId: PROPERTY, siteOrigin: BETA }, {}]) {
    assert.equal((await h.send("POST", `${api()}/ga4/reporting/prepare`, input)).status, 400, JSON.stringify(input));
  }
  // (c) Search Console は対象 origin のルート URL-prefix 完全一致だけ。sc-domain・別 origin・パス付き・未確認は拒否
  const prepareSearch = (property) => h.send("POST", `${api()}/search-console/reporting/prepare`, { property });
  for (const property of [{ kind: "domain", value: "sc-domain:alpha.example" }, { kind: "url-prefix", value: `${BETA}/` }, { kind: "url-prefix", value: `${ALPHA}/blog/` }, { kind: "url-prefix", value: ALPHA }, { kind: "url-prefix", value: "https://alpha.example/" }]) {
    assert.deepEqual(await body(await prepareSearch(property), 409), { error: "property_mismatch" }, property.value);
  }
  h.state.gscPermissions[`${ALPHA}/`] = "siteUnverifiedUser";
  assert.deepEqual(await body(await prepareSearch({ kind: "url-prefix", value: `${ALPHA}/` }), 409), { error: "permission_required" });
  for (const status of [403, 404]) {
    h.state.fail.gscSite = status;
    assert.deepEqual(await body(await prepareSearch({ kind: "url-prefix", value: `${ALPHA}/` }), 409), { error: "permission_required" }, String(status));
  }
  h.state.fail.gscSite = null;
  assert.equal(h.count("site_analytics_plans"), 0, "不一致・権限なしでは plan を作らない");
  assert.equal(h.count("site_analytics_connections"), 0);

  // 共有 origin + path の Studio-native site と公開 origin の無いサイトは未対応
  const managed = await body(await h.send("GET", `${api("project-managed", "site-managed")}/connection`), 200);
  assert.deepEqual(managed.target, target("project-managed", "site-managed", SHARED));
  assert.equal(managed.ga4.reportingState, "not-connected"); assert.equal(managed.searchConsole.reportingState, "not-connected");
  assert.deepEqual(await body(await h.send("POST", `${api("project-managed", "site-managed")}/ga4/reporting/prepare`, { propertyId: PROPERTY }), 409), { error: "unsupported_site" });
  assert.deepEqual(await body(await h.send("POST", `${api("project-managed", "site-managed")}/search-console/reporting/prepare`, { property: { kind: "url-prefix", value: `${SHARED}/` } }), 409), { error: "unsupported_site" });
  for (const [project, site] of [["project-managed", "site-managed"], ["project-none", "site-none"]]) {
    const value = await report(h, "28d", {}, project, site);
    assert.deepEqual([value.ga4, value.searchConsole], [{ state: "not-connected" }, { state: "not-connected" }]);
  }
  assert.deepEqual(await body(await h.send("GET", `${api("project-none", "site-none")}/connection`), 409), { error: "unsupported_site" });
  assert.equal((await body(await h.send("GET", "/api/projects/project-managed/sites/site-managed/dashboard"), 200)).analytics.status, "disconnected");

  // 計測タグの公開・削除と所有権確認は、このホストでは扱わない
  for (const path of ["/ga4/tag/prepare", "/ga4/tag/apply", "/ga4/tag/remove/prepare", "/ga4/tag/remove/apply", "/search-console/ownership/prepare", "/search-console/ownership/apply", "/search-console/ownership/verify"]) {
    assert.deepEqual(await body(await h.send("POST", `${api()}${path}`, {}), 409), { error: "not_supported" }, path);
    assert.equal((await h.send("POST", `${api()}${path}`, {}, { as: EDITOR })).status, 403);
  }
  assert.equal((await h.send("GET", `${api()}/unknown`)).status, 404);
  assert.equal((await h.send("GET", `${api()}/ga4/reporting/prepare`)).status, 405);
  assert.equal((await h.send("POST", `${api()}/report`, {})).status, 405);
  assert.equal((await h.send("GET", `${api()}/report?period=30d`)).status, 400);
  assert.equal((await h.send("GET", `${api()}/report?period=28d&origin=${encodeURIComponent(BETA)}`)).status, 400, "リクエスト由来の origin は受け付けない");
  assertQuietLogs(h.logs);
});

testWithD1("editors only read, outsiders get nothing, and plans are one-time, short-lived, actor- and version-bound", async (t) => {
  const h = await fixture(t);
  await connectGa4(h);
  // (d) editor は読み取りだけ
  assert.equal((await body(await h.send("GET", `${api()}/connection`, undefined, { as: EDITOR }), 200)).ga4.propertyId, PROPERTY);
  assert.equal((await report(h, "28d", { as: EDITOR })).ga4.state, "available");
  const ownerPlan = await body(await h.send("POST", `${api()}/ga4/reporting/disconnect/prepare`, {}), 200);
  for (const [path, input] of [["/ga4/reporting/prepare", { propertyId: PROPERTY }], ["/ga4/reporting/verify", {}], ["/ga4/reporting/retry", {}], ["/ga4/reporting/disconnect/prepare", {}], ["/ga4/reporting/disconnect/apply", { confirmationToken: ownerPlan.confirmationToken }], ["/search-console/reporting/prepare", { property: { kind: "url-prefix", value: `${ALPHA}/` } }]]) {
    assert.deepEqual(await body(await h.send("POST", `${api()}${path}`, input, { as: EDITOR }), 403), { error: "forbidden" }, path);
  }
  // 参加していない人は何も読めない
  for (const path of ["/connection", "/report?period=28d"]) assert.deepEqual(await body(await h.send("GET", `${api()}${path}`, undefined, { as: OUTSIDER }), 403), { error: "forbidden" });
  assert.equal((await h.send("POST", `${api()}/ga4/reporting/prepare`, { propertyId: PROPERTY }, { as: OUTSIDER })).status, 403);
  assert.equal((await h.send("GET", `${api("project-nope", "site-nope")}/connection`)).status, 403);
  // same-origin・JSON の境界
  assert.equal((await h.send("POST", `${api()}/ga4/reporting/prepare`, { propertyId: PROPERTY }, { sameOrigin: false })).status, 400);

  // (g) token は一回限り
  await body(await h.send("POST", `${api()}/ga4/reporting/disconnect/apply`, { confirmationToken: ownerPlan.confirmationToken }), 200);
  assert.deepEqual(await body(await h.send("POST", `${api()}/ga4/reporting/disconnect/apply`, { confirmationToken: ownerPlan.confirmationToken }), 409), { error: "plan_invalid" });
  assert.equal((await body(await h.send("GET", `${api()}/connection`), 200)).ga4.reportingState, "not-connected");
  assert.equal(h.count("site_analytics_cache", "site_id = 'site-alpha'"), 0, "解除で古い cache を消す");
  assert.deepEqual((await report(h)).ga4, { state: "not-connected" });

  // 期限切れ
  const expiring = await body(await h.send("POST", `${api()}/ga4/reporting/prepare`, { propertyId: PROPERTY }), 200);
  h.sqlite.exec("UPDATE site_analytics_plans SET created_at = created_at - 600, expires_at = expires_at - 600");
  assert.deepEqual(await body(await h.send("POST", `${api()}/ga4/reporting/apply`, { confirmationToken: expiring.confirmationToken }), 409), { error: "plan_invalid" });
  // 別の操作の token は使えない
  const ga4Plan = await body(await h.send("POST", `${api()}/ga4/reporting/prepare`, { propertyId: PROPERTY }), 200);
  assert.deepEqual(await body(await h.send("POST", `${api()}/search-console/reporting/apply`, { confirmationToken: ga4Plan.confirmationToken }), 409), { error: "plan_invalid" });
  assert.deepEqual(await body(await h.send("POST", `${api()}/ga4/reporting/disconnect/apply`, { confirmationToken: ga4Plan.confirmationToken }), 409), { error: "plan_invalid" });
  // version 競合: 同じ version から2つ準備し、先に適用した方だけが通る
  const second = await body(await h.send("POST", `${api()}/ga4/reporting/prepare`, { propertyId: PROPERTY }), 200);
  await body(await h.send("POST", `${api()}/ga4/reporting/apply`, { confirmationToken: ga4Plan.confirmationToken }), 200);
  assert.deepEqual(await body(await h.send("POST", `${api()}/ga4/reporting/apply`, { confirmationToken: second.confirmationToken }), 409), { error: "version_conflict" });
  assert.equal(h.sqlite.prepare("SELECT version FROM site_analytics_connections WHERE site_id = 'site-alpha'").get().version, 3);
  // 別サイトの token・別の owner の token は使えない。失敗した apply は plan を消費しない
  const betaPlan = await body(await h.send("POST", `${api("project-beta", "site-beta")}/ga4/reporting/prepare`, { propertyId: PROPERTY }), 200);
  assert.deepEqual(await body(await h.send("POST", `${api()}/ga4/reporting/apply`, { confirmationToken: betaPlan.confirmationToken }), 409), { error: "plan_invalid" });
  assert.deepEqual(await body(await h.send("POST", `${api("project-beta", "site-beta")}/ga4/reporting/apply`, { confirmationToken: betaPlan.confirmationToken }, { as: OUTSIDER }), 409), { error: "plan_invalid" });
  assert.equal(h.count("site_analytics_plans", "site_id = 'site-beta'"), 1);
  // plan の後に owner でなくなった人は適用できない
  h.sqlite.prepare("UPDATE project_members SET role = 'editor' WHERE project_id = 'project-beta' AND access_subject = ?").run(OWNER);
  assert.equal((await h.send("POST", `${api("project-beta", "site-beta")}/ga4/reporting/apply`, { confirmationToken: betaPlan.confirmationToken })).status, 403);
  h.sqlite.prepare("UPDATE project_members SET role = 'owner' WHERE project_id = 'project-beta' AND access_subject = ?").run(OWNER);
  await body(await h.send("POST", `${api("project-beta", "site-beta")}/ga4/reporting/apply`, { confirmationToken: betaPlan.confirmationToken }), 200);
  const beta = h.sqlite.prepare("SELECT ga4_stream_id, ga4_stream_origin, ga4_tracking_tag_state, ga4_measurement_id FROM site_analytics_connections WHERE site_id = 'site-beta'").get();
  assert.deepEqual({ ...beta }, { ga4_stream_id: "22", ga4_stream_origin: BETA, ga4_tracking_tag_state: "failed", ga4_measurement_id: "G-BETA00002" });
  // 計測タグを確認できない（取得失敗）ときは状態と測定IDを示す
  const betaConnection = await body(await h.send("GET", `${api("project-beta", "site-beta")}/connection`), 200);
  assert.deepEqual([betaConnection.ga4.trackingTagState, betaConnection.ga4.measurementId], ["failed", "G-BETA00002"]);
  assertQuietLogs(h.logs);
});

testWithD1("the same GA4 property never returns another Studio site's numbers", async (t) => {
  const h = await fixture(t);
  await connectGa4(h);
  await connectGa4(h, "project-beta", "site-beta");
  const alpha = await report(h), beta = await report(h, "28d", {}, "project-beta", "site-beta");
  assert.deepEqual(alpha.ga4.report.sessions, { current: 120, previous: 100 });
  assert.deepEqual(beta.ga4.report.sessions, { current: 999, previous: 9 });
  assert.deepEqual(beta.ga4.report.topPages.map((row) => row.page.path), ["/beta-only"]);
  assert.equal(JSON.stringify(alpha).includes("beta-only"), false);
  // 同じプロパティでも、要求は各サイトの stream と host で絞る
  const scopes = new Set(h.calls.runReport.map(({ body: request }) => request.dimensionFilter.andGroup.expressions.slice(0, 2).map((expression) => expression.filter.stringFilter.value).join("|")));
  assert.deepEqual([...scopes].sort(), ["11|www.alpha.example", "22|beta.example"]);
  // 別の接続 version の cache 行（別サイトの値を入れた不正な行）は使わない
  const version = h.sqlite.prepare("SELECT version FROM site_analytics_connections WHERE site_id = 'site-alpha'").get().version;
  const forged = { ...beta.ga4, report: { ...beta.ga4.report, range: alpha.ga4.report.range, previousRange: alpha.ga4.report.previousRange } };
  h.sqlite.prepare(`INSERT INTO site_analytics_cache (site_id, source, period, connection_version, range_end, result_json, expires_at)
    VALUES ('site-alpha', 'ga4', '7d', ?, ?, ?, unixepoch() + 600)`).run(version + 5, alpha.ga4.report.range.end, JSON.stringify(forged));
  const week = await report(h, "7d");
  assert.deepEqual(week.ga4.report.sessions, { current: 120, previous: 100 });
  assert.equal(h.sqlite.prepare("SELECT connection_version FROM site_analytics_cache WHERE site_id = 'site-alpha' AND source = 'ga4' AND period = '7d'").get().connection_version, version);
  // 公開 origin が変わったら、以前の origin で接続したストリームの値は返さない
  h.sqlite.exec(`UPDATE sites SET public_origin = 'https://renamed.alpha.example' WHERE id = 'site-alpha'`);
  assert.deepEqual((await report(h)).ga4, { state: "failed" });
  const moved = await body(await h.send("GET", `${api()}/connection`), 200);
  assert.equal(moved.target.siteOrigin, "https://renamed.alpha.example"); assert.equal(moved.ga4.reportingState, "property-mismatch");
  assertQuietLogs(h.logs);
});

testWithD1("permission loss marks the connection revoked and never serves the old cache", async (t) => {
  const h = await fixture(t);
  await connectGa4(h);
  await connectSearchConsole(h);
  assert.equal((await report(h)).ga4.state, "available");
  assert.equal(h.count("site_analytics_cache", "source = 'ga4'"), 1);
  // (h) 403 を検知したら permission-revoked にし、cache を消して返さない
  h.state.fail.ga4Report = 403;
  const revoked = await report(h, "7d");
  assert.deepEqual(revoked.ga4, { state: "permission-expired" });
  assert.equal(revoked.searchConsole.state, "available");
  assert.equal(h.count("site_analytics_cache", "source = 'ga4'"), 0);
  const calls = h.calls.runReport.length;
  assert.deepEqual((await report(h)).ga4, { state: "permission-expired" }, "28日の cache があっても返さない");
  assert.equal(h.calls.runReport.length, calls, "失効中は Google を呼ばない");
  assert.equal((await body(await h.send("GET", `${api()}/connection`), 200)).ga4.reportingState, "permission-revoked");
  assert.equal((await body(await h.send("GET", "/api/projects/project-alpha/sites/site-alpha/dashboard"), 200)).analytics.status, "unavailable");
  // 権限が戻ったら接続を確認して再開する
  h.state.fail.ga4Report = null;
  await body(await h.send("POST", `${api()}/ga4/reporting/verify`, {}), 200);
  assert.equal((await body(await h.send("GET", `${api()}/connection`), 200)).ga4.reportingState, "connected");
  assert.equal((await report(h)).ga4.state, "available");
  // 401 でも同じ。失効した token は捨てて取り直す
  h.state.fail.gscQuery = 401;
  const tokens = h.calls.token;
  await body(await h.send("POST", `${api()}/search-console/reporting/retry`, {}), 200);
  assert.equal((await body(await h.send("GET", `${api()}/connection`), 200)).searchConsole.reportingState, "permission-revoked");
  assert.deepEqual((await report(h)).searchConsole, { state: "permission-expired" });
  h.state.fail.gscQuery = null;
  await body(await h.send("POST", `${api()}/search-console/reporting/verify`, {}), 200);
  assert.ok(h.calls.token > tokens, "401 の後は token を取り直す");
  assert.equal((await report(h)).searchConsole.state, "available");
  h.state.gscPermissions[`${ALPHA}/`] = "siteUnverifiedUser";
  await body(await h.send("POST", `${api()}/search-console/reporting/verify`, {}), 200);
  assert.equal((await body(await h.send("GET", `${api()}/connection`), 200)).searchConsole.reportingState, "permission-required");
  assert.deepEqual((await report(h)).searchConsole, { state: "permission-expired" });
  // 計測タグ: HTML から消えたら not-configured（測定IDは示さない）
  h.state.html[ALPHA] = { status: 200, body: "<html><head></head><body>G-ALPHA00011 is not the tag</body></html>" };
  await body(await h.send("POST", `${api()}/ga4/reporting/verify`, {}), 200);
  const untagged = await body(await h.send("GET", `${api()}/connection`), 200);
  assert.deepEqual([untagged.ga4.trackingTagState, untagged.ga4.measurementId, untagged.ga4.reportingState], ["not-configured", null, "connected"]);
  // 接続したストリームが消えたら不一致（別のストリームへ自動で切り替えない）
  h.state.properties[PROPERTY].streams = [web(77, "G-ALPHA0077", ALPHA)];
  await body(await h.send("POST", `${api()}/ga4/reporting/verify`, {}), 200);
  assert.equal((await body(await h.send("GET", `${api()}/connection`), 200)).ga4.reportingState, "property-mismatch");
  assert.deepEqual((await report(h)).ga4, { state: "failed" });
  assertQuietLogs(h.logs);
});

testWithD1("without the service-account secret nothing breaks and changes are unavailable", async (t) => {
  for (const secret of [null, "{\"type\":\"service_account\",\"client_email\":\"x@fixture.invalid\",\"private_key\":\"not a key\"}"]) {
    await t.test(secret === null ? "missing" : "malformed", async (st) => {
      const h = await fixture(st, { secret });
      const connection = await body(await h.send("GET", `${api()}/connection`), 200);
      assert.deepEqual([connection.ga4.reportingState, connection.searchConsole.reportingState], ["not-connected", "not-connected"]);
      const value = await report(h);
      assert.deepEqual([value.ga4, value.searchConsole], [{ state: "not-connected" }, { state: "not-connected" }]);
      assert.deepEqual((await body(await h.send("GET", "/api/projects/project-alpha/sites/site-alpha/dashboard"), 200)).analytics, { status: "disconnected" });
      assert.deepEqual(await body(await h.send("POST", `${api()}/ga4/reporting/prepare`, { propertyId: PROPERTY }), 503), { error: "analytics_unavailable" });
      assert.deepEqual(await body(await h.send("POST", `${api()}/search-console/reporting/prepare`, { property: { kind: "url-prefix", value: `${ALPHA}/` } }), 503), { error: "analytics_unavailable" });
      // 接続済みの行があっても落ちない（取れない source は failed、Dashboard は unavailable）
      h.sqlite.prepare(`INSERT INTO site_analytics_connections (site_id, ga4_property_id, ga4_stream_id, ga4_stream_origin, ga4_measurement_id, ga4_time_zone, ga4_reporting_state, ga4_tracking_tag_state, updated_by_subject)
        VALUES ('site-alpha', ?, '11', ?, 'G-ALPHA0001', 'Asia/Tokyo', 'connected', 'published', ?)`).run(PROPERTY, ALPHA, OWNER);
      assert.deepEqual((await report(h)).ga4, { state: "failed" });
      assert.equal((await body(await h.send("GET", "/api/projects/project-alpha/sites/site-alpha/dashboard"), 200)).analytics.status, "unavailable");
      assert.deepEqual(await body(await h.send("POST", `${api()}/ga4/reporting/verify`, {}), 503), { error: "analytics_unavailable" });
      assert.deepEqual(await body(await h.send("POST", `${api()}/ga4/reporting/retry`, {}), 503), { error: "analytics_unavailable" });
      assert.equal(h.calls.token + h.calls.runReport.length + h.calls.admin.length, 0, "Google を呼ばない");
      assertQuietLogs(h.logs);
    });
  }
});

testWithD1("Search Console leaves previous values unknown when the previous range is older than the 16-month history", async (t) => {
  const h = await fixture(t);
  await connectSearchConsole(h);
  // 12か月の直前期は約24〜12か月前で、Search Analytics の16か月の履歴を超える。取得せず、比較値は未取得（null）
  const yearly = await report(h, "12m");
  assert.equal(yearly.searchConsole.state, "available");
  const previousStart = yearly.searchConsole.report.previousRange.start;
  assert.equal(h.calls.gsc.some((call) => call.body.startDate === previousStart), false, "直前期は問い合わせない");
  for (const metric of ["clicks", "impressions", "ctr", "averagePosition"]) assert.equal(yearly.searchConsole.report[metric].previous, null, metric);
  for (const page of yearly.searchConsole.report.topPages) { assert.equal(page.clicks.previous, null); assert.equal(page.impressions.previous, null); }
  // 3か月の直前期は履歴の中なので、これまでどおり問い合わせて比較値を出す
  const quarterly = await report(h, "3m");
  const quarterStart = quarterly.searchConsole.report.previousRange.start;
  assert.ok(h.calls.gsc.some((call) => call.body.startDate === quarterStart), "直前期を問い合わせる");
  assert.equal(quarterly.searchConsole.report.clicks.previous, 0);
});

testWithD1("a late successful fetch does not revive a connection that another request marked as revoked", async (t) => {
  const h = await fixture(t);
  await connectGa4(h);
  // 取得の途中で、ほかの要求が権限失効を記録した（cache も消した）状態を作る
  h.state.onRunReport = () => {
    h.sqlite.prepare("UPDATE site_analytics_connections SET ga4_reporting_state = 'permission-revoked' WHERE site_id = 'site-alpha'").run();
    h.sqlite.prepare("DELETE FROM site_analytics_cache WHERE site_id = 'site-alpha'").run();
  };
  await report(h, "7d");
  h.state.onRunReport = null;
  // 遅れて届いた成功で connected に戻さず、cache も作らない
  assert.equal((await body(await h.send("GET", `${api()}/connection`), 200)).ga4.reportingState, "permission-revoked");
  assert.equal(h.count("site_analytics_cache", "site_id = 'site-alpha' AND source = 'ga4'"), 0);
  assert.equal((await report(h, "7d")).ga4.state, "permission-expired");
  // 明示の再試行で権限が確かめられたときだけ戻る
  await body(await h.send("POST", `${api()}/ga4/reporting/retry`, {}), 200);
  assert.equal((await body(await h.send("GET", `${api()}/connection`), 200)).ga4.reportingState, "connected");
  assert.equal((await report(h, "7d")).ga4.state, "available");
});
