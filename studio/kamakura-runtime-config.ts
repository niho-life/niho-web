import { KAMAKURA_CMS_UPLOAD_ORIGIN, KAMAKURA_MEDIA_ORIGIN } from "./kamakura-cms-contract.js";

declare global {
  interface Window {
    __NIHO_STUDIO_RUNTIME__?: { readonly kamakuraUploadOrigin?: unknown; readonly kamakuraMediaOrigin?: unknown };
  }
}

/** Runtime config はStudio Worker自身が生成する。HTTPS Preview origin以外へtokenを送らない。 */
export function kamakuraStudioUploadOrigin(): string {
  const configured = typeof window === "undefined" ? undefined : window.__NIHO_STUDIO_RUNTIME__?.kamakuraUploadOrigin;
  if (typeof configured !== "string") return KAMAKURA_CMS_UPLOAD_ORIGIN;
  try {
    const url = new URL(configured);
    if (url.protocol === "https:" && url.origin === configured && !url.username && !url.password
      && url.hostname.toLowerCase().split(".").some((label) => label.split("-").includes("preview"))
      && configured !== KAMAKURA_CMS_UPLOAD_ORIGIN) return configured;
  } catch { /* fall back to the production API origin */ }
  return KAMAKURA_CMS_UPLOAD_ORIGIN;
}

/** Previewの公開画像はupload gateway経由で配信し、本番の固定media originは保つ。 */
export function kamakuraStudioMediaOrigin(): string {
  const runtime = typeof window === "undefined" ? undefined : window.__NIHO_STUDIO_RUNTIME__;
  const configured = runtime?.kamakuraMediaOrigin;
  if (typeof configured !== "string" || configured !== runtime?.kamakuraUploadOrigin) return KAMAKURA_MEDIA_ORIGIN;
  try {
    const url = new URL(configured);
    if (url.protocol === "https:" && url.origin === configured && !url.username && !url.password
      && !url.search && !url.hash
      && url.hostname.toLowerCase().split(".").some((label) => label.split("-").includes("preview"))
      && configured !== KAMAKURA_MEDIA_ORIGIN) return configured;
  } catch { /* use the production media origin */ }
  return KAMAKURA_MEDIA_ORIGIN;
}
