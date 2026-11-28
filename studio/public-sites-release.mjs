import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { pendingMigrations } from "./release.mjs";

const studio = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(studio, "..");
const requiredPublicMigrations = new Set([
  "0016_static_page_publication.sql",
  "0017_managed_public_embeds.sql",
  "0018_managed_public_domains.sql",
  "0019_managed_site_redirects.sql",
  "0020_managed_published_paths.sql",
  "0021_managed_page_sources.sql",
  "0023_managed_site_primary_host.sql"
]);
const allowedStudioOnlyMigrations = new Set([
  "0022_managed_site_redirect_versions.sql",
  "0024_managed_one_step_publish.sql",
  "0025_managed_site_imports.sql",
  "0026_managed_site_styles.sql",
  "0027_managed_site_publication_history_details.sql"
]);

export function classifyPublicReleaseMigrations(pending) {
  return {
    required: pending.filter((name) => requiredPublicMigrations.has(name)),
    unknown: pending.filter((name) => !requiredPublicMigrations.has(name) && !allowedStudioOnlyMigrations.has(name))
  };
}

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

function configuredWorkerNames() {
  return ["./wrangler.json", "./public-sites.wrangler.json"].map((file) => {
    const config = JSON.parse(readFileSync(join(studio, file), "utf8"));
    return config.name;
  });
}

export function readPublicSitesReleaseSettings(env) {
  const accountId = requireValue(env, "CLOUDFLARE_ACCOUNT_ID", (value) => /^[a-f0-9]{32}$/iu.test(value));
  const databaseId = requireValue(env, "STUDIO_DATABASE_ID", (value) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value));
  const studioOrigin = requireValue(env, "STUDIO_ORIGIN", isHttpsOrigin);
  const publicOrigin = requireValue(env, "PUBLIC_SITES_ORIGIN", (value) => value !== studioOrigin && isHttpsOrigin(value));
  const workerName = requireValue(env, "PUBLIC_SITES_WORKER_NAME", (value) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value));
  const previewOrigin = requireValue(env, "PUBLIC_SITES_PREVIEW_ORIGIN", (value) => {
    if (value === studioOrigin || value === publicOrigin || !isHttpsOrigin(value)) return false;
    const labels = new URL(value).hostname.split(".");
    return labels.length === 4 && labels[0] === workerName && labels[2] === "workers" && labels[3] === "dev";
  });
  if (configuredWorkerNames().includes(workerName)) throw new ReleaseError("PUBLIC_SITES_WORKER_NAME は専用 Worker の名前を指定してください。");
  const smokePath = requireValue(env, "PUBLIC_SITES_SMOKE_PATH", (value) => {
    if (!/^\/s\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:[A-Za-z0-9/_-]*)$/u.test(value)) return false;
    try { return new URL(value, previewOrigin).pathname === value; }
    catch { return false; }
  });
  return { accountId, databaseId, studioOrigin, publicOrigin, previewOrigin, workerName, hostname: new URL(previewOrigin).hostname, smokePath };
}

export function writePublicSitesConfig(directory, settings) {
  const config = JSON.parse(readFileSync(join(studio, "public-sites.wrangler.json"), "utf8"));
  delete config.$schema;
  config.name = settings.workerName;
  config.main = resolve(studio, config.main);
  config.assets.directory = resolve(studio, config.assets.directory);
  config.workers_dev = true;
  delete config.routes;
  config.d1_databases[0].database_id = settings.databaseId;
  config.vars = { PUBLIC_SITES_PREVIEW_ORIGIN: settings.previewOrigin };
  const migrationsDirectory = config.d1_databases[0].migrations_dir;
  cpSync(join(studio, migrationsDirectory), join(directory, migrationsDirectory), { recursive: true });
  const configPath = join(directory, "wrangler.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  return configPath;
}

export async function smokePublicSitesPreview(settings, request = fetch) {
  let response;
  try {
    response = await request(`${settings.previewOrigin}${settings.smokePath}`, {
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(12_000),
      redirect: "error"
    });
  } catch {
    throw new ReleaseError("検証用ページへのリクエストが失敗しました。preview host、DNS、公開 Worker の route を確認してください。");
  }
  const type = response.headers.get("Content-Type")?.toLowerCase().split(";")[0];
  const robots = response.headers.get("X-Robots-Tag")?.toLowerCase().split(",").map((value) => value.trim()) ?? [];
  if (response.status !== 200 || type !== "text/html" || !robots.includes("noindex") || !robots.includes("nofollow")) {
    throw new ReleaseError("検証用ページが HTTP 200 の HTML と noindex, nofollow を返しません。");
  }
  const html = await response.text();
  if (!html || html.length > 5_000_000 || !/<html(?:\s|>)/iu.test(html)) {
    throw new ReleaseError("検証用ページの HTML が空か、許容サイズを超えています。");
  }
  return { bytes: Buffer.byteLength(html) };
}

function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("STUDIO_") || key.startsWith("PUBLIC_SITES_") || key === "CLOUDFLARE_ACCOUNT_ID") delete env[key];
  }
  return env;
}

function runWrangler(config, settings, step, ...args) {
  const env = { ...childEnv(), CLOUDFLARE_ACCOUNT_ID: settings.accountId, CI: "true", WRANGLER_LOG: "log",
    WRANGLER_WRITE_LOGS: "false", WRANGLER_SEND_METRICS: "false" };
  console.log(step);
  const result = spawnSync(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), ...args, "--config", config],
    { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new ReleaseError(`${step}で Wrangler が失敗しました。出力には内部設定を含むため Cloudflare の管理画面で確認してください。`);
  return result.stdout;
}

function buildAndTest() {
  const env = childEnv();
  delete env.CLOUDFLARE_API_TOKEN;
  for (const task of ["test", "studio:typecheck", "studio:build"]) {
    console.log(`npm run ${task}`);
    const result = spawnSync("npm", ["run", task], { cwd: root, env, stdio: "inherit" });
    if (result.status !== 0) throw new ReleaseError(`npm run ${task} が失敗しました。`);
  }
}

async function release() {
  if (process.argv.length !== 2) throw new ReleaseError("studio:public:release には引数を渡さず、studio/README.md の非公開設定を使ってください。");
  const settings = readPublicSitesReleaseSettings(process.env);
  buildAndTest();
  const directory = mkdtempSync(join(tmpdir(), "niho-public-sites-release-"));
  let deployStarted = false;
  try {
    const config = writePublicSitesConfig(directory, settings);
    const wrangler = (...args) => runWrangler(config, settings, ...args);
    const pending = pendingMigrations(wrangler("D1 の migration 状況を確認", "d1", "migrations", "list", "DB", "--remote"));
    const migrations = classifyPublicReleaseMigrations(pending);
    if (migrations.unknown.length) throw new ReleaseError("配備前に未確認の D1 migration が残っています。Studio 配備手順を確認してください。");
    if (migrations.required.length) throw new ReleaseError("公開配信に必要な D1 migration が未適用です。Studio release を先に実行してください。");
    deployStarted = true;
    wrangler("preview host 専用の公開 Worker を配備", "deploy");
    console.log("配備後に preview page の noindex を確認");
    let result;
    for (let attempt = 1; ; attempt++) {
      try { result = await smokePublicSitesPreview(settings); break; }
      catch (error) {
        if (attempt === 3) throw error;
        await wait(5_000);
      }
    }
    console.log(`preview host の HTML smoke が完了しました（${result.bytes} bytes）。`);
  } catch (error) {
    console.error(error instanceof ReleaseError ? error.message : "公開 Worker の配備で、想定外の応答またはエラーが発生しました。");
    if (deployStarted) console.error("影響範囲は preview host です。Cloudflare の配備履歴で preview Worker の状態を確認してください。");
    process.exitCode = 1;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await release(); }
  catch (error) {
    console.error(error instanceof ReleaseError ? error.message : "公開 Worker の配備準備でエラーが発生しました。");
    process.exitCode = 1;
  }
}
