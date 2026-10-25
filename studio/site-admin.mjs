import { integrationIdentity } from "./integration-registry.mjs";

/**
 * サイト側の管理画面を Studio の中の枠で開くサイト（kamakura-site#108 U1）。管理画面の origin はコードに書かず、
 * Worker の設定値（originEnv）から読む。CMS・翻訳を Studio の画面へ移したら（U2・U3）ここから外す。
 *
 * cmsViewEnv: CMS を Studio のコレクション画面（CollectionWorkspace）で開くかの切替。値が "workspace" のときだけ
 * 新しい画面、無い・ほかの値は従来の枠（"frame"）。受入が終わるまで既定は枠のまま。
 */
const SITE_ADMINS = new Map([
  [integrationIdentity("project-kamakura", "kamakura"), Object.freeze({ originEnv: "KAMAKURA_ADMIN_ORIGIN", cmsViewEnv: "KAMAKURA_CMS_VIEW", paths: Object.freeze({ cms: "/admin", translations: "/admin/localization" }) })]
]);

/** 設定値を https の origin だけに絞る（パス・認証情報・クエリのある値は使わない） */
function httpsOrigin(value) {
  if (typeof value !== "string" || !value) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  return url.origin;
}

/** そのサイトの管理画面（origin、枠で開く画面のパス、CMS の開き方）。未接続・未設定は null */
export function siteAdmin(env, projectId, siteId) {
  const config = SITE_ADMINS.get(integrationIdentity(projectId, siteId));
  if (!config) return null;
  const origin = httpsOrigin(env?.[config.originEnv]);
  return origin ? Object.freeze({ origin, paths: config.paths, cmsView: env?.[config.cmsViewEnv] === "workspace" ? "workspace" : "frame" }) : null;
}
