import { integrationIdentity } from "./integration-registry.mjs";

/** Studio に CMS・素材・翻訳の画面を接続したサイト。 */
const CONNECTED_SITES = new Set([integrationIdentity("project-kamakura", "kamakura")]);

export function siteAdmin(projectId, siteId) {
  return CONNECTED_SITES.has(integrationIdentity(projectId, siteId)) ? { connected: true } : null;
}
