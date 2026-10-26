export type ProjectSiteViewId = "cms" | "assets" | "translations";
export type ProjectAliasPage = "dashboard" | "editor" | ProjectSiteViewId;
/** CMS の下の階層（`/admin/cms/<collectionId>/<itemId>`）。コレクションの一覧は itemId が null */
export type ProjectCmsRoute = { readonly collectionId: string; readonly itemId: string | null };
/** 翻訳の下の階層（`/admin/translations/<itemKey>`）。一覧は itemKey が null（URL には下の階層を書かない） */
export type ProjectTranslationsRoute = { readonly itemKey: string | null };

export type ProjectAliasRoute = {
  readonly slug: string; readonly projectId: string; readonly siteId: string; readonly page: ProjectAliasPage;
  readonly cms?: ProjectCmsRoute; readonly translations?: ProjectTranslationsRoute;
};

export const PROJECT_SITE_VIEWS: readonly ProjectSiteViewId[];
export function parseProjectAliasPath(pathname: string): ProjectAliasRoute | null;
export function projectShortcutTarget(pathname: string): string | null;
export function projectAliasPath(projectId: string, siteId: string, page: ProjectAliasPage, sub?: ProjectCmsRoute | ProjectTranslationsRoute | null): string | null;
export function projectRoutePath(currentPathname: string, projectId: string, siteId: string, page: ProjectAliasPage, sub?: ProjectCmsRoute | ProjectTranslationsRoute | null): string;
