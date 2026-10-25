/** CMS の開き方。"frame" はサイト側の管理画面を枠で、"workspace" は Studio のコレクション画面で開く */
export type SiteCmsView = "frame" | "workspace";
export type SiteAdmin = { readonly origin: string; readonly paths: { readonly cms: string; readonly translations: string }; readonly cmsView: SiteCmsView };
export function siteAdmin(env: Record<string, unknown> | undefined, projectId: string, siteId: string): SiteAdmin | null;
