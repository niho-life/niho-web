export type SiteAdmin = { readonly connected: true };
export function siteAdmin(projectId: string, siteId: string): SiteAdmin | null;
