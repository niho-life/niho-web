import { readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const studio = join(root, "studio");
const envPath = process.env.NIHO_WEB_STUDIO_PREVIEW_ENV_FILE
  ? resolve(process.env.NIHO_WEB_STUDIO_PREVIEW_ENV_FILE)
  : join(homedir(), ".config", "niho-web", "studio-preview.env");
const templatePath = join(studio, "wrangler.preview.template.toml");
const generatedPath = join(studio, `.wrangler.preview.generated-${randomUUID()}.toml`);

function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([A-Z0-9_]+)=([^\r\n]*)$/u.exec(line.trim());
    if (!match || line.trim().startsWith("#")) continue;
    values[match[1]] = match[2];
  }
  return values;
}

function requireValue(values, key, pattern, label) {
  const value = values[key];
  if (!value || !pattern.test(value)) throw new Error(`Preview 設定 ${key}（${label}）をローカル環境設定に追加してください`);
  return value;
}

function requireOrigin(values, key, label) {
  const value = values[key];
  let url;
  try { url = new URL(value); } catch { throw new Error(`Preview 設定 ${key}（${label}）が HTTPS origin ではありません`); }
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password || url.search || url.hash) {
    throw new Error(`Preview 設定 ${key}（${label}）が HTTPS origin ではありません`);
  }
  return value;
}

let generated = false;
try {
  const values = parseEnv(await readFile(envPath, "utf8"));
  const accountId = requireValue(values, "CLOUDFLARE_ACCOUNT_ID", /^[a-f0-9]{32}$/iu, "Cloudflare account ID");
  const host = requireValue(values, "STUDIO_PREVIEW_HOST", /^[a-z0-9.-]+$/iu, "Studio Preview hostname");
  if (!host.toLowerCase().split(".").some((label) => label.split("-").includes("preview"))) throw new Error("Studio Preview hostname に preview を含めてください");
  const hostUrl = new URL(`https://${host}`);
  if (hostUrl.hostname !== host || hostUrl.pathname !== "/" || hostUrl.search || hostUrl.hash) throw new Error("Studio Preview hostname を確認してください");
  const databaseId = requireValue(values, "STUDIO_PREVIEW_DATABASE_ID", /^[a-f0-9-]{36}$/iu, "Preview D1 ID");
  const databaseName = requireValue(values, "STUDIO_PREVIEW_DATABASE_NAME", /^[a-z0-9-]+$/u, "Preview D1 name");
  const cmsBucket = requireValue(values, "STUDIO_PREVIEW_CMS_BUCKET", /^[a-z0-9-]+$/u, "Preview CMS R2 name");
  const kamakuraWorker = requireValue(values, "KAMAKURA_PREVIEW_WORKER_NAME", /^[a-z0-9-]+$/u, "Kamakura Preview Worker name");
  const studioWorker = requireValue(values, "STUDIO_PREVIEW_WORKER_NAME", /^[a-z0-9-]+$/u, "Studio Preview Worker name");
  const audience = requireValue(values, "STUDIO_PREVIEW_ACCESS_AUDIENCE", /^[a-f0-9]{64}$/iu, "Access audience tag");
  const issuer = requireOrigin(values, "STUDIO_PREVIEW_ACCESS_ISSUER", "Access issuer");
  const uploadOrigin = requireOrigin(values, "KAMAKURA_PREVIEW_UPLOAD_ORIGIN", "Kamakura upload gateway");
  const siteOrigin = requireOrigin(values, "KAMAKURA_PREVIEW_SITE_ORIGIN", "Kamakura Preview site");
  if (!new URL(uploadOrigin).hostname.toLowerCase().split(".").some((label) => label.split("-").includes("preview"))) throw new Error("Kamakura upload gateway は Preview host を指定してください");
  if (!new URL(siteOrigin).hostname.toLowerCase().split(".").some((label) => label.split("-").includes("preview"))
    || siteOrigin === uploadOrigin || siteOrigin === `https://${host}`) throw new Error("Kamakura Preview site はStudio・upload gatewayとは別の Preview host を指定してください");

  let config = await readFile(templatePath, "utf8");
  const substitutions = {
    __STUDIO_PREVIEW_HOST__: host,
    __STUDIO_PREVIEW_ACCESS_ISSUER__: issuer,
    __STUDIO_PREVIEW_ACCESS_AUDIENCE__: audience,
    __KAMAKURA_PREVIEW_UPLOAD_ORIGIN__: uploadOrigin,
    __KAMAKURA_PREVIEW_SITE_ORIGIN__: siteOrigin,
    __STUDIO_PREVIEW_DATABASE_ID__: databaseId,
    __STUDIO_PREVIEW_DATABASE_NAME__: databaseName,
    __STUDIO_PREVIEW_CMS_BUCKET__: cmsBucket,
    __KAMAKURA_PREVIEW_WORKER_NAME__: kamakuraWorker,
    __STUDIO_PREVIEW_WORKER_NAME__: studioWorker,
  };
  for (const [placeholder, value] of Object.entries(substitutions)) config = config.replaceAll(placeholder, JSON.stringify(value));
  if (/__[A-Z0-9_]+__/u.test(config)) throw new Error("Preview template に未設定の項目があります");
  config = `account_id = ${JSON.stringify(accountId)}\n${config}`;
  await writeFile(generatedPath, config, { mode: 0o600, flag: "wx" });
  generated = true;

  const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
  const wranglerArgs = process.argv.slice(2);
  if (wranglerArgs[0] === "d1" && wranglerArgs[1] === "migrations" && ["apply", "list"].includes(wranglerArgs[2]) && wranglerArgs[3] === "preview") {
    wranglerArgs[3] = databaseName;
  }
  const result = spawnSync(process.execPath, [wrangler, ...wranglerArgs, "--config", generatedPath], {
    cwd: root,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "Studio Preview の Wrangler 設定を読み込めませんでした");
  process.exitCode = 1;
} finally {
  if (generated) await rm(generatedPath, { force: true });
}
