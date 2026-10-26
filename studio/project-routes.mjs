import { TRUSTED_INTEGRATIONS } from "./integration-registry.mjs";

const PROJECT_ALIASES = Object.freeze(TRUSTED_INTEGRATIONS.flatMap((registration) => registration.aliases.map((slug) => Object.freeze({
  slug, projectId: registration.projectId, siteId: registration.siteId
}))));

/** Dashboard の中で開くサイト機能（ホストが接続したものだけ表示する）。URL の末尾と同じ名前 */
export const PROJECT_SITE_VIEWS = Object.freeze(["cms", "assets", "translations"]);
const PAGE_PATTERN = `(editor|${PROJECT_SITE_VIEWS.join("|")})`;
/**
 * サイト機能の下の階層。CMS は `/<collectionId>/<itemId>`（形は collection-model の key・項目の id と同じ）、
 * 翻訳は `/<itemKey>`（形は localization-workspace-model の itemKey と同じ）。どちらも URL にそのまま書ける文字だけ。
 * ほかの画面は下の階層を持たない。
 */
const COLLECTION_SEGMENT = "[A-Za-z0-9_][A-Za-z0-9_-]{0,79}";
const ITEM_SEGMENT = "[A-Za-z0-9_][A-Za-z0-9._~-]{0,127}";
const TRANSLATION_SEGMENT = "[A-Za-z0-9_-]{1,200}";
const SUB_PATTERN = "((?:/[^/]+){1,2})?";
const RESERVED_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const isSegment = (value, pattern) => typeof value === "string" && new RegExp(`^${pattern}$`, "u").test(value) && !RESERVED_SEGMENTS.has(value);

/**
 * URL のサイト機能の下の階層。無ければ {}、CMS は { cms }、翻訳は { translations }。
 * ほかの画面に付いている・形が違う・予約語なら null（その URL は扱わない）
 */
function subRoute(page, rest) {
  if (rest === undefined) return {};
  const segments = rest.slice(1).split("/");
  if (page === "cms") {
    const [collectionId, itemId] = segments;
    if (!isSegment(collectionId, COLLECTION_SEGMENT) || (itemId !== undefined && !isSegment(itemId, ITEM_SEGMENT))) return null;
    return { cms: Object.freeze({ collectionId, itemId: itemId ?? null }) };
  }
  if (page === "translations" && segments.length === 1 && isSegment(segments[0], TRANSLATION_SEGMENT)) return { translations: Object.freeze({ itemKey: segments[0] }) };
  return null;
}

/** URL に書く CMS の下の階層。形の違う値は書かない（一覧・コレクションの入口に戻す） */
function cmsSuffix(cms) {
  if (!cms || !isSegment(cms.collectionId, COLLECTION_SEGMENT)) return "";
  return `/${cms.collectionId}${isSegment(cms.itemId, ITEM_SEGMENT) ? `/${cms.itemId}` : ""}`;
}

/** URL に書く翻訳の下の階層（1 件）。形の違う値は書かない（一覧に戻す） */
function translationsSuffix(translations) {
  return translations && isSegment(translations.itemKey, TRANSLATION_SEGMENT) ? `/${translations.itemKey}` : "";
}

function pageSuffix(page, sub) {
  return page === "cms" ? cmsSuffix(sub) : page === "translations" ? translationsSuffix(sub) : "";
}

export function parseProjectAliasPath(pathname) {
  const match = new RegExp(`^/projects/([a-z][a-z0-9-]*)/admin(?:/${PAGE_PATTERN}${SUB_PATTERN})?/?$`, "u").exec(pathname);
  if (!match) return null;
  const project = PROJECT_ALIASES.find(({ slug }) => slug === match[1]);
  if (!project) return null;
  const page = match[2] ?? "dashboard";
  const sub = subRoute(page, match[3]);
  if (sub === null) return null;
  return { ...project, page, ...sub };
}

/** 覚えやすい入口 `/project/<別名>`（kamakura-site#108）。正の alias URL `/projects/<別名>/admin…` へ移す先。対象外は null */
export function projectShortcutTarget(pathname) {
  const match = new RegExp(`^/project/([a-z][a-z0-9-]*)(?:/${PAGE_PATTERN}${SUB_PATTERN})?/?$`, "u").exec(pathname);
  if (!match || !PROJECT_ALIASES.some(({ slug }) => slug === match[1])) return null;
  const sub = subRoute(match[2], match[3]);
  if (sub === null) return null;
  return `/projects/${match[1]}/admin${match[2] ? `/${match[2]}` : ""}${pageSuffix(match[2], sub.cms ?? sub.translations ?? null)}`;
}

/** sub は CMS なら { collectionId, itemId }、翻訳なら { itemKey }。ほかの画面では使わない */
export function projectAliasPath(projectId, siteId, page, sub = null) {
  const project = PROJECT_ALIASES.find((candidate) => candidate.projectId === projectId && candidate.siteId === siteId);
  if (!project) return null;
  return `/projects/${project.slug}/admin${page === "dashboard" ? "" : `/${page}`}${pageSuffix(page, sub)}`;
}

export function projectRoutePath(currentPathname, projectId, siteId, page, sub = null) {
  const currentAlias = parseProjectAliasPath(currentPathname);
  // サイト機能の画面は alias の URL だけが持つ（ID の URL には下の階層が無い）
  const aliasPath = currentAlias?.projectId === projectId && currentAlias.siteId === siteId || PROJECT_SITE_VIEWS.includes(page)
    ? projectAliasPath(projectId, siteId, page, sub)
    : null;
  if (aliasPath) return aliasPath;
  return `/projects/${encodeURIComponent(projectId)}/sites/${encodeURIComponent(siteId)}${page === "editor" ? "/editor" : ""}`;
}
