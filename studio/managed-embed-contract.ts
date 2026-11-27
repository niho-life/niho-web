import { isSafeHttpsOrigin } from "../src/validation-utils.js";
import { emptyManagedSiteSeoSettings, parseManagedSiteSeoSettings, type ManagedSiteSeoSettings } from "../src/managed-seo-settings.js";
export { MANAGED_EMBED_REF, managedBlockContracts, managedEmbedContract } from "../src/managed-embed-block.js";

export type ManagedPublicPolicy = { frameOrigins: string[]; resourceOrigins: string[]; seo: ManagedSiteSeoSettings };
export function emptyManagedPublicPolicy(): ManagedPublicPolicy {
  return { frameOrigins: [], resourceOrigins: [], seo: emptyManagedSiteSeoSettings() };
}
export function isCspHttpsOrigin(value: unknown): value is string {
  return isSafeHttpsOrigin(value) && /^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/u.test(value);
}

export function parseManagedPublicPolicy(value: unknown, parentOrigin: string): ManagedPublicPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "frameOrigins,ga4MeasurementId,resourceOrigins" && keys !== "frameOrigins,resourceOrigins,seo"
    && keys !== "frameOrigins,ga4MeasurementId,resourceOrigins,seo") return null;
  const { frameOrigins, resourceOrigins, ga4MeasurementId } = value as Record<string, unknown>;
  const validOrigins = (list: unknown): list is string[] =>
    Array.isArray(list) && list.length <= 24 && list.every((origin) =>
      isCspHttpsOrigin(origin) && origin.length <= 253 && origin !== parentOrigin && !new URL(origin).port) &&
    new Set(list).size === list.length;
  if (!validOrigins(frameOrigins) || !validOrigins(resourceOrigins)) return null;
  if (ga4MeasurementId !== undefined && ga4MeasurementId !== null && (typeof ga4MeasurementId !== "string" || !/^G-[A-Z0-9]{4,20}$/u.test(ga4MeasurementId))) return null;
  const rawSeo = (value as Record<string, unknown>).seo;
  let seo = rawSeo === undefined ? null : parseManagedSiteSeoSettings(rawSeo);
  if (rawSeo === undefined) seo = { ...emptyManagedSiteSeoSettings(), ga4MeasurementId: typeof ga4MeasurementId === "string" ? ga4MeasurementId : null };
  if (!seo) return null;
  if (ga4MeasurementId !== undefined && ga4MeasurementId !== seo.ga4MeasurementId) return null;
  const image = seo.defaultOgImage;
  if (image && /^https:\/\//iu.test(image) && new URL(image).origin !== parentOrigin && !resourceOrigins.includes(new URL(image).origin)) return null;
  return { frameOrigins: [...frameOrigins].sort(), resourceOrigins: [...resourceOrigins].sort(), seo };
}

const NIHO_ORIGIN = "https://niho.life";
const NIHO_ROUTE = /^\/embed\/(dropin|rental|inquiry)\/([A-Za-z0-9_-]{1,160})$/u;
const EMBED_QUERY_KEYS = new Set(["launchToken", "embed", "bg", "accent"]);

export function nihoEmbedTarget(source: string): { url: URL; flow: string; spotId: string } | null {
  let url: URL;
  try { url = new URL(source); } catch { return null; }
  const route = NIHO_ROUTE.exec(url.pathname);
  if (!route || url.origin !== NIHO_ORIGIN || url.username || url.password || url.hash) return null;
  return { url, flow: route[1]!, spotId: route[2]! };
}

/** NIHO が署名を検証する。Studio は設定の形式と公開先の一致だけを検証する。 */
export function registeredNihoEmbed(value: unknown, parentOrigin: string, publicPath: string): URL | null {
  if (typeof value !== "string" || value.length > 8192 || /[\s\u0000-\u001f\u007f\\<>]/u.test(value)) return null;
  const target = nihoEmbedTarget(value);
  if (!target || target.url.origin === parentOrigin) return null;
  const { url, flow, spotId } = target, query = url.searchParams;
  for (const key of query.keys()) if (!EMBED_QUERY_KEYS.has(key) || query.getAll(key).length !== 1) return null;
  if (query.has("embed") && query.get("embed") !== "1" ||
    query.has("bg") && query.get("bg") !== "transparent" ||
    query.has("accent") && !/^[a-f0-9]{6}$/iu.test(query.get("accent")!)) return null;
  const token = /^([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]{43}$/u.exec(query.get("launchToken") ?? "");
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token[1]!.replaceAll("-", "+").replaceAll("_", "/"))) as Record<string, unknown> | null;
    if (!payload || payload.v !== 1 || payload.flow !== flow || payload.spotId !== spotId ||
      payload.parentOrigin !== parentOrigin || typeof payload.publicId !== "string" || !payload.publicId ||
      !Number.isSafeInteger(payload.launchTokenVersion) || Number(payload.launchTokenVersion) < 1) return null;
    const prefix = payload.allowedPathPrefix;
    if (prefix !== null && (typeof prefix !== "string" ||
      !/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?)?$/u.test(prefix) ||
      prefix !== "/" && publicPath !== prefix.replace(/\/$/u, "") && !publicPath.startsWith(prefix.replace(/\/$/u, "") + "/"))) return null;
    return url;
  } catch { return null; }
}
