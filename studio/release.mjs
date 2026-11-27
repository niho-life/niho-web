import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";

const studio = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(studio, "..");
const workerName = "niho-web-studio";
const output = join(studio, "dist/public");
const rollbackFile = ".studio-rollback-version";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const identifier = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u;
const entryScript = /<script type="module" src="(\/assets\/app-[a-f0-9]{12}\.js)"><\/script>/u;
const dashboardImport = /import\("\.\/(chunks\/project-dashboard-[A-Za-z0-9_-]{8}\.js)"\)/u;
const requiredSecrets = ["KAMAKURA_STUDIO_BRIDGE_SECRET"];
// List each migration checked against the old Worker's reads and writes before enabling it here.
const beforeDeployMigrations = new Set([
  "0015_cms_delivery.sql",
  "0016_static_page_publication.sql",
  "0017_managed_page_sources.sql",
  "0018_managed_public_embeds.sql",
  "0019_managed_public_domains.sql",
  "0020_managed_site_redirects.sql",
  "0021_managed_published_paths.sql",
  "0022_managed_site_redirect_versions.sql",
  "0023_managed_site_primary_host.sql",
  "0024_managed_one_step_publish.sql",
  "0025_managed_site_imports.sql"
]);

class ReleaseError extends Error {}

function requireValue(env, key, accepts) {
  const value = env[key];
  if (!value || !accepts(value)) throw new ReleaseError(`${key} が未設定か、形式が正しくありません。`);
  return value;
}

function isHttpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.port;
  } catch { return false; }
}

export function readReleaseSettings(env) {
  const accountId = requireValue(env, "CLOUDFLARE_ACCOUNT_ID", (value) => /^[a-f0-9]{32}$/iu.test(value));
  const databaseId = requireValue(env, "STUDIO_DATABASE_ID", (value) => uuid.test(value));
  const studioOrigin = requireValue(env, "STUDIO_ORIGIN", isHttpsOrigin);
  const publicOrigin = requireValue(env, "PUBLIC_SITES_ORIGIN", (value) => value !== studioOrigin && isHttpsOrigin(value));
  const previewOrigin = env.PUBLIC_SITES_PREVIEW_ORIGIN
    ? requireValue(env, "PUBLIC_SITES_PREVIEW_ORIGIN", (value) => value !== studioOrigin && value !== publicOrigin && isHttpsOrigin(value))
    : null;
  const accessIssuer = requireValue(env, "STUDIO_ACCESS_ISSUER", isHttpsOrigin);
  const accessAudience = requireValue(env, "STUDIO_ACCESS_AUDIENCE", (value) => /^[a-f0-9]{64}$/iu.test(value));
  const project = requireValue(env, "STUDIO_SMOKE_PROJECT_ID", (value) => identifier.test(value));
  const site = requireValue(env, "STUDIO_SMOKE_SITE_ID", (value) => identifier.test(value));
  const publicPath = requireValue(env, "STUDIO_SMOKE_PUBLIC_PATH", (value) => {
    if (!/^\/s\/[a-z0-9]+(?:-[a-z0-9]+)*\//u.test(value)) return false;
    return new URL(value, publicOrigin).pathname === value;
  });
  const token = requireValue(env, "STUDIO_SMOKE_ACCESS_TOKEN", (value) => value.length <= 64 * 1024 && /^[\w-]+\.[\w-]+\.[\w-]+$/u.test(value));
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); }
  catch { throw new ReleaseError("STUDIO_SMOKE_ACCESS_TOKEN を読み取れません。"); }
  if (claims?.type !== "app" || !claims.sub || typeof claims.email !== "string" || !claims.email ||
      claims.iss !== accessIssuer || ![claims.aud].flat().includes(accessAudience) || !Number.isSafeInteger(claims.exp)) {
    throw new ReleaseError("STUDIO_SMOKE_ACCESS_TOKEN に対象の Access application のユーザー JWT を指定してください。");
  }
  const settings = { accountId, databaseId, studioOrigin, publicOrigin, previewOrigin, accessIssuer, accessAudience, project, site, publicPath, token, expiresAt: claims.exp };
  checkExpiry(settings, 120);
  return settings;
}

function checkExpiry(settings, margin) {
  if (settings.expiresAt <= Date.now() / 1000 + margin) throw new ReleaseError("STUDIO_SMOKE_ACCESS_TOKEN の有効期限が足りません。Access で再認証してください。");
}

export function pendingMigrations(stdout) {
  const lines = stripVTControlCharacters(stdout).split(/\r?\n/u).map((line) => line.trim());
  const tableStart = lines.indexOf("Migrations to be applied:");
  if (tableStart === -1 && lines.includes("✅ No migrations to apply!")) return [];
  const rows = lines.slice(tableStart + 1).filter((line) => line.startsWith("│"));
  if (tableStart === -1 || rows.shift()?.replaceAll("│", "").trim() !== "Name" || !rows.length) {
    throw new ReleaseError("Wrangler の migration 一覧を読み取れません。Wrangler CLI の出力形式を確認してください。");
  }
  return rows.map((row) => {
    const name = /^│\s+([0-9]+_[a-z0-9_-]+\.sql)\s+│$/u.exec(row)?.[1];
    if (!name || !beforeDeployMigrations.has(name)) throw new ReleaseError("配備前に適用できる migration の一覧と保留中の migration が一致しません。studio/README.md の手順を確認してください。");
    return name;
  });
}

export function registeredManagedSiteSlug(stdout) {
  let output;
  try { output = JSON.parse(stripVTControlCharacters(stdout)); }
  catch { throw new ReleaseError("登録済みサイトの slug を読み取れません。"); }
  const rowArrays = [];
  let failed = false;
  const visit = (value) => {
    if (Array.isArray(value)) {
      if (value.length && value.every((row) => row && typeof row === "object" && !Array.isArray(row) && Object.hasOwn(row, "slug"))) {
        rowArrays.push(value);
      } else {
        value.forEach(visit);
      }
      return;
    }
    if (value && typeof value === "object") {
      if (value.success === false) failed = true;
      Object.values(value).forEach(visit);
    }
  };
  visit(output);
  const rows = rowArrays.length === 1 ? rowArrays[0] : [];
  const slug = rows.length === 1 ? rows[0].slug : undefined;
  if (failed || typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
    throw new ReleaseError("登録済みサイトの slug を一意に確認できません。");
  }
  return slug;
}

function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("STUDIO_") || key === "PUBLIC_SITES_ORIGIN" || key === "PUBLIC_SITES_PREVIEW_ORIGIN") delete env[key];
  }
  return env;
}

function buildAndTest() {
  const env = childEnv();
  delete env.CLOUDFLARE_ACCOUNT_ID;
  delete env.CLOUDFLARE_API_TOKEN;
  for (const task of ["test", "studio:typecheck", "studio:build"]) {
    console.log(`npm run ${task}`);
    const result = spawnSync("npm", ["run", task], { cwd: root, env, stdio: "inherit" });
    if (result.status !== 0) throw new ReleaseError(`npm run ${task} が失敗しました。`);
  }
}

function buildAssets() {
  const entry = entryScript.exec(readFileSync(join(output, "index.html"), "utf8"))?.[1];
  if (!entry) throw new ReleaseError("Studio ビルドに版付きの entry script がありません。");
  const script = readFileSync(join(output, entry));
  const chunk = dashboardImport.exec(script.toString("utf8"))?.[1];
  if (!chunk) throw new ReleaseError("Studio ビルドに Dashboard の遅延読込 chunk がありません。");
  const chunkPath = `/assets/${chunk}`;
  return { entry, script, chunkPath, chunk: readFileSync(join(output, chunkPath)) };
}

export function writeConfig(directory, settings) {
  const config = JSON.parse(readFileSync(join(studio, "wrangler.json"), "utf8"));
  delete config.$schema;
  config.name = workerName;
  config.main = resolve(studio, config.main);
  config.assets.directory = resolve(studio, config.assets.directory);
  config.routes = [settings.studioOrigin, settings.publicOrigin].map((origin) => ({ pattern: new URL(origin).hostname, custom_domain: true }));
  config.d1_databases[0].database_id = settings.databaseId;
  config.vars = { ACCESS_ISSUER: settings.accessIssuer, ACCESS_AUDIENCE: settings.accessAudience, PUBLIC_SITES_ORIGIN: settings.publicOrigin,
    ...(settings.previewOrigin ? { PUBLIC_SITES_PREVIEW_ORIGIN: settings.previewOrigin } : {}) };
  config.keep_vars = true;
  config.secrets = { required: requiredSecrets };
  const migrationsDirectory = config.d1_databases[0].migrations_dir;
  // Use the same snapshot for list and apply even if the working tree changes mid-release.
  cpSync(join(studio, migrationsDirectory), join(directory, migrationsDirectory), { recursive: true });
  const configPath = join(directory, "wrangler.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  return configPath;
}

function runWrangler(config, settings, step, ...args) {
  const env = { ...childEnv(), CLOUDFLARE_ACCOUNT_ID: settings.accountId, CI: "true", WRANGLER_LOG: "log", WRANGLER_WRITE_LOGS: "false", WRANGLER_SEND_METRICS: "false" };
  console.log(step);
  // Wrangler output can contain account, binding, domain and deployment details.
  const result = spawnSync(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), ...args, "--config", config],
    { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new ReleaseError(`${step}で Wrangler が失敗しました。出力には内部設定を含むため Cloudflare の管理画面で確認してください。`);
  return result.stdout;
}

function savePreviousVersion(version) {
  const temporary = join(studio, `${rollbackFile}.${process.pid}`);
  try {
    writeFileSync(temporary, `${version}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, join(studio, rollbackFile));
  } finally { rmSync(temporary, { force: true }); }
}

function smokeRequest(settings, request = fetch) {
  async function getResponse(label, path, publicPage = false) {
    const origin = publicPage ? settings.publicOrigin : settings.studioOrigin;
    const headers = { "Cache-Control": "no-cache" };
    if (!publicPage) headers["CF-Access-Token"] = settings.token;
    try {
      return await request(`${origin}${path}`, { signal: AbortSignal.timeout(12_000), headers, redirect: "error" });
    } catch (error) {
      if (error instanceof ReleaseError) throw error;
      throw new ReleaseError(`${label} へのリクエストが失敗しました。ネットワーク、Access、リダイレクトを確認してください。`);
    }
  }
  async function get(label, path, mime, publicPage = false) {
    const response = await getResponse(label, path, publicPage);
    if (response.status !== 200) throw new ReleaseError(`${label} が HTTP ${response.status} を返しました。`);
    const type = response.headers.get("Content-Type")?.toLowerCase().split(";")[0];
    if (!mime.includes(type)) throw new ReleaseError(`${label} の Content-Type が正しくありません。`);
    return Buffer.from(await response.arrayBuffer());
  }
  return { get, getResponse };
}

async function smokeDashboardApi(settings, get, readRegisteredSlug) {
  const session = JSON.parse(await get("/api/session", "/api/session", ["application/json"]));
  if (session?.status !== "authenticated" || !session.subject || !session.email) throw new ReleaseError("/api/session でユーザーを確認できません。");
  const path = `/projects/${settings.project}/sites/${settings.site}`;
  const dashboard = JSON.parse(await get("Dashboard API", `/api${path}/dashboard`, ["application/json"]));
  if (dashboard?.status !== "ready" || dashboard.projectId !== settings.project || dashboard.siteId !== settings.site || dashboard.members?.status !== "ready") {
    throw new ReleaseError("Dashboard API で対象サイトとメンバー一覧を確認できません。対象サイトとユーザーの権限を確認してください。");
  }
  const configuredSitePath = /^\/s\/[^/]+\//u.exec(settings.publicPath)?.[0] ?? "";
  const configuredSiteSlug = /^\/s\/([^/]+)\//u.exec(settings.publicPath)?.[1] ?? "";
  if (typeof readRegisteredSlug !== "function" || !configuredSiteSlug
    || await readRegisteredSlug(settings.project, settings.site) !== configuredSiteSlug) {
    throw new ReleaseError("smoke の公開 path が対象サイトの登録済み slug と一致しません。");
  }
  const publishedUrl = dashboard.overview?.data?.publishedUrl;
  let publishedSitePath = "";
  try {
    const published = new URL(publishedUrl);
    if (published.origin === settings.publicOrigin) publishedSitePath = /^\/s\/[^/]+\//u.exec(published.pathname)?.[0] ?? "";
  } catch { /* unavailable or invalid URL */ }
  const unpublishedManagedSite = publishedUrl === null && dashboard.overview?.data?.publicationStatus === "unpublished"
    && dashboard.overview?.data?.publishedPageCount === 0 && settings.publicPath === configuredSitePath;
  const publishedManagedSite = dashboard.overview?.data?.publicationStatus === "published"
    && Number.isSafeInteger(dashboard.overview?.data?.publishedPageCount) && dashboard.overview.data.publishedPageCount > 0
    && publishedSitePath !== "" && publishedSitePath === configuredSitePath;
  if (dashboard.overview?.status !== "ready" || !configuredSitePath || (!publishedManagedSite && !unpublishedManagedSite)) {
    throw new ReleaseError("Dashboard API の対象サイトと smoke の公開 path が一致しません。");
  }
  return { path, published: publishedManagedSite };
}

export async function smokeStudio(settings, assets, request = fetch, readRegisteredSlug) {
  const { get, getResponse } = smokeRequest(settings, request);
  const { path, published } = await smokeDashboardApi(settings, get, readRegisteredSlug);
  const dashboard = await get("Dashboard HTML", path, ["text/html"]);
  if (entryScript.exec(dashboard.toString("utf8"))?.[1] !== assets.entry) throw new ReleaseError("Dashboard HTML が今回の配備の entry script を参照していません。");
  const scriptTypes = ["application/javascript", "text/javascript"];
  if (!(await get("Studio entry script", assets.entry, scriptTypes)).equals(assets.script)) throw new ReleaseError("Studio entry script が今回のビルドと一致しません。");
  if (!(await get("Dashboard の遅延読込 chunk", assets.chunkPath, scriptTypes)).equals(assets.chunk)) throw new ReleaseError("Dashboard の遅延読込 chunk が今回のビルドと一致しません。");
  if (published) {
    const page = await get("代表公開ページ", settings.publicPath, ["text/html"], true);
    if (!page.toString("utf8").includes(`<meta property="og:url" content="${settings.publicOrigin}${settings.publicPath}"`)) {
      throw new ReleaseError("代表公開ページの og:url が指定した公開 URL と一致しません。");
    }
  } else {
    const response = await getResponse("未公開サイトの公開 path", settings.publicPath, true);
    const headers = response.headers;
    const body = await response.arrayBuffer();
    if (response.status !== 404 || headers.get("Content-Type")?.toLowerCase().split(";")[0] !== "text/plain"
      || headers.get("Cache-Control") !== "no-store" || headers.get("X-Content-Type-Options") !== "nosniff"
      || headers.get("Cross-Origin-Resource-Policy") !== "same-origin" || headers.get("Referrer-Policy") !== "no-referrer"
      || headers.get("X-Frame-Options") !== "DENY" || body.byteLength !== 0) {
      throw new ReleaseError("未公開サイトの公開 path が安全な404を返しません。");
    }
  }
}

async function release() {
  if (process.argv.length !== 2) throw new ReleaseError("studio:release には引数を渡さず、studio/README.md の環境変数を設定してください。");
  const settings = readReleaseSettings(process.env);
  buildAndTest();
  const assets = buildAssets();
  const directory = mkdtempSync(join(tmpdir(), "niho-studio-release-"));
  let deployStarted = false;
  try {
    const config = writeConfig(directory, settings);
    const wrangler = (...args) => runWrangler(config, settings, ...args);
    const readRegisteredSlug = (project, site) => {
      const sql = `SELECT ms.slug FROM managed_sites AS ms JOIN sites AS s ON s.id = ms.site_id WHERE s.project_id = '${project}' AND s.id = '${site}' LIMIT 2`;
      const stdout = wrangler("対象サイトの登録済み slug を確認", "d1", "execute", "DB", "--remote", "--json", "--command", sql);
      return registeredManagedSiteSlug(stdout);
    };
    const status = () => JSON.parse(wrangler("Worker の配備状況を確認", "deployments", "status", "--json"));
    const previous = status();
    const prior = previous.versions?.length === 1 && previous.versions[0];
    if (!uuid.test(previous.id) || !prior || prior.percentage !== 100 || !uuid.test(prior.version_id)) throw new ReleaseError("切り戻し先となる現在の単一 Worker version を確認できません。");
    const secrets = JSON.parse(wrangler("Worker secret の設定を確認", "secret", "list", "--format", "json"));
    for (const name of requiredSecrets) if (!secrets.some((secret) => secret.name === name)) throw new ReleaseError(`Worker secret ${name} を設定してください。`);

    checkExpiry(settings, 120);
    console.log("Access セッションと Dashboard の権限を確認");
    await smokeDashboardApi(settings, smokeRequest(settings).get, readRegisteredSlug);
    const list = () => pendingMigrations(wrangler("D1 の migration 状況を確認", "d1", "migrations", "list", "DB", "--remote"));
    const pending = list();
    if (pending.length) {
      console.log(`配備前に適用する migration は ${pending.length} 件です。`);
      wrangler("D1 の migration を適用", "d1", "migrations", "apply", "DB", "--remote", "--force");
      if (list().length) throw new ReleaseError("D1 に未適用の migration が残っています。");
    }

    checkExpiry(settings, 60);
    if (status().id !== previous.id) throw new ReleaseError("配備前の確認後に Worker の配備が変更されました。対象を確認してください。");
    savePreviousVersion(prior.version_id);
    deployStarted = true;
    wrangler("Studio Worker を配備", "deploy");
    console.log("配備後の smoke を実行");
    for (let attempt = 1; ; attempt++) {
      try { await smokeStudio(settings, assets, fetch, readRegisteredSlug); break; }
      catch (error) {
        if (attempt === 3) throw error;
        await wait(5_000);
      }
    }
    console.log("Studio Worker の配備と smoke が完了しました。");
  } catch (error) {
    console.error(error instanceof ReleaseError ? error.message : "Studio の配備処理で、想定外の応答またはエラーが発生しました。");
    if (deployStarted) {
      console.error("Cloudflare の配備履歴を確認し、この配備が有効なら保存した Worker version へ切り戻してください。D1 に適用した migration は残ります。");
      console.error(`npx wrangler rollback "$(cat studio/${rollbackFile})" --name ${workerName}`);
    }
    process.exitCode = 1;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await release(); }
  catch (error) {
    console.error(error instanceof ReleaseError ? error.message : "Studio の配備準備でエラーが発生しました。");
    process.exitCode = 1;
  }
}
