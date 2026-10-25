export type ProjectSiteViewId = "cms" | "assets" | "translations";
export type ProjectAliasPage = "dashboard" | "editor" | ProjectSiteViewId;

export type ProjectAliasRoute = { readonly slug: string; readonly projectId: string; readonly siteId: string; readonly page: ProjectAliasPage };

export const PROJECT_SITE_VIEWS: readonly ProjectSiteViewId[];
export function parseProjectAliasPath(pathname: string): ProjectAliasRoute | null;
export function projectShortcutTarget(pathname: string): string | null;
export function projectAliasPath(projectId: string, siteId: string, page: ProjectAliasPage): string | null;
export function projectRoutePath(currentPathname: string, projectId: string, siteId: string, page: ProjectAliasPage): string;
