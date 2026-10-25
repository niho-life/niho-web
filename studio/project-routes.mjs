import { TRUSTED_INTEGRATIONS } from "./integration-registry.mjs";

const PROJECT_ALIASES = Object.freeze(TRUSTED_INTEGRATIONS.flatMap((registration) => registration.aliases.map((slug) => Object.freeze({
  slug, projectId: registration.projectId, siteId: registration.siteId
}))));

/** Dashboard の中で開くサイト機能（ホストが接続したものだけ表示する）。URL の末尾と同じ名前 */
export const PROJECT_SITE_VIEWS = Object.freeze(["cms", "assets", "translations"]);
const PAGE_PATTERN = `(editor|${PROJECT_SITE_VIEWS.join("|")})`;

export function parseProjectAliasPath(pathname) {
  const match = new RegExp(`^/projects/([a-z][a-z0-9-]*)/admin(?:/${PAGE_PATTERN})?/?$`, "u").exec(pathname);
  if (!match) return null;
  const project = PROJECT_ALIASES.find(({ slug }) => slug === match[1]);
  if (!project) return null;
  return { ...project, page: match[2] ?? "dashboard" };
}

/** 覚えやすい入口 `/project/<別名>`（kamakura-site#108）。正の alias URL `/projects/<別名>/admin…` へ移す先。対象外は null */
export function projectShortcutTarget(pathname) {
  const match = new RegExp(`^/project/([a-z][a-z0-9-]*)(?:/${PAGE_PATTERN})?/?$`, "u").exec(pathname);
  if (!match || !PROJECT_ALIASES.some(({ slug }) => slug === match[1])) return null;
  return `/projects/${match[1]}/admin${match[2] ? `/${match[2]}` : ""}`;
}

export function projectAliasPath(projectId, siteId, page) {
  const project = PROJECT_ALIASES.find((candidate) => candidate.projectId === projectId && candidate.siteId === siteId);
  if (!project) return null;
  return `/projects/${project.slug}/admin${page === "dashboard" ? "" : `/${page}`}`;
}

export function projectRoutePath(currentPathname, projectId, siteId, page) {
  const currentAlias = parseProjectAliasPath(currentPathname);
  // サイト機能の画面は alias の URL だけが持つ（ID の URL には下の階層が無い）
  const aliasPath = currentAlias?.projectId === projectId && currentAlias.siteId === siteId || PROJECT_SITE_VIEWS.includes(page)
    ? projectAliasPath(projectId, siteId, page)
    : null;
  if (aliasPath) return aliasPath;
  return `/projects/${encodeURIComponent(projectId)}/sites/${encodeURIComponent(siteId)}${page === "editor" ? "/editor" : ""}`;
}
