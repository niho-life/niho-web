import { isKamakuraProject } from "./project-routes.mjs";

/** Studio に CMS・素材・翻訳の画面を接続したサイト。 */
export function siteAdmin(projectId, siteId) {
  return isKamakuraProject(projectId, siteId) ? { connected: true } : null;
}
