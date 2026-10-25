import { TRUSTED_INTEGRATIONS } from "./integration-registry.mjs";

const PROJECT_ALIASES = Object.freeze(TRUSTED_INTEGRATIONS.flatMap((registration) => registration.aliases.map((slug) => Object.freeze({
  slug, projectId: registration.projectId, siteId: registration.siteId
}))));

/** Dashboard の中で開くサイト機能（ホストが接続したものだけ表示する）。URL の末尾と同じ名前 */
export const PROJECT_SITE_VIEWS = Object.freeze(["cms", "assets", "translations"]);
const PAGE_PATTERN = `(editor|${PROJECT_SITE_VIEWS.join("|")})`;
/**
 * CMS の下の階層 `/<collectionId>/<itemId>`。形は collection-model の key・項目の id と同じ（どちらも URL にそのまま書ける文字だけ）。
 * CMS 以外の画面は下の階層を持たない。
 */
const COLLECTION_SEGMENT = "[A-Za-z0-9_][A-Za-z0-9_-]{0,79}";
const ITEM_SEGMENT = "[A-Za-z0-9_][A-Za-z0-9._~-]{0,127}";
const CMS_PATTERN = `(?:/(${COLLECTION_SEGMENT})(?:/(${ITEM_SEGMENT}))?)?`;
const RESERVED_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const isSegment = (value, pattern) => typeof value === "string" && new RegExp(`^${pattern}$`, "u").test(value) && !RESERVED_SEGMENTS.has(value);

/** URL の CMS の下の階層。無ければ null、cms 以外の画面に付いている・予約語なら undefined（その URL は扱わない） */
function cmsRoute(page, collectionId, itemId) {
  if (collectionId === undefined) return null;
  if (page !== "cms" || RESERVED_SEGMENTS.has(collectionId) || (itemId !== undefined && RESERVED_SEGMENTS.has(itemId))) return undefined;
  return Object.freeze({ collectionId, itemId: itemId ?? null });
}

/** URL に書く CMS の下の階層。形の違う値は書かない（一覧・コレクションの入口に戻す） */
function cmsSuffix(cms) {
  if (!cms || !isSegment(cms.collectionId, COLLECTION_SEGMENT)) return "";
  return `/${cms.collectionId}${isSegment(cms.itemId, ITEM_SEGMENT) ? `/${cms.itemId}` : ""}`;
}

export function parseProjectAliasPath(pathname) {
  const match = new RegExp(`^/projects/([a-z][a-z0-9-]*)/admin(?:/${PAGE_PATTERN}${CMS_PATTERN})?/?$`, "u").exec(pathname);
  if (!match) return null;
  const project = PROJECT_ALIASES.find(({ slug }) => slug === match[1]);
  if (!project) return null;
  const page = match[2] ?? "dashboard";
  const cms = cmsRoute(page, match[3], match[4]);
  if (cms === undefined) return null;
  return cms ? { ...project, page, cms } : { ...project, page };
}

/** 覚えやすい入口 `/project/<別名>`（kamakura-site#108）。正の alias URL `/projects/<別名>/admin…` へ移す先。対象外は null */
export function projectShortcutTarget(pathname) {
  const match = new RegExp(`^/project/([a-z][a-z0-9-]*)(?:/${PAGE_PATTERN}${CMS_PATTERN})?/?$`, "u").exec(pathname);
  if (!match || !PROJECT_ALIASES.some(({ slug }) => slug === match[1])) return null;
  const cms = cmsRoute(match[2], match[3], match[4]);
  if (cms === undefined) return null;
  return `/projects/${match[1]}/admin${match[2] ? `/${match[2]}` : ""}${cmsSuffix(cms)}`;
}

export function projectAliasPath(projectId, siteId, page, cms = null) {
  const project = PROJECT_ALIASES.find((candidate) => candidate.projectId === projectId && candidate.siteId === siteId);
  if (!project) return null;
  return `/projects/${project.slug}/admin${page === "dashboard" ? "" : `/${page}`}${page === "cms" ? cmsSuffix(cms) : ""}`;
}

export function projectRoutePath(currentPathname, projectId, siteId, page, cms = null) {
  const currentAlias = parseProjectAliasPath(currentPathname);
  // サイト機能の画面は alias の URL だけが持つ（ID の URL には下の階層が無い）
  const aliasPath = currentAlias?.projectId === projectId && currentAlias.siteId === siteId || PROJECT_SITE_VIEWS.includes(page)
    ? projectAliasPath(projectId, siteId, page, cms)
    : null;
  if (aliasPath) return aliasPath;
  return `/projects/${encodeURIComponent(projectId)}/sites/${encodeURIComponent(siteId)}${page === "editor" ? "/editor" : ""}`;
}
