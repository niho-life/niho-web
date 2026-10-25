export type SiteAdmin = { readonly origin: string; readonly paths: { readonly cms: string; readonly translations: string } };
export function siteAdmin(env: Record<string, unknown> | undefined, projectId: string, siteId: string): SiteAdmin | null;
