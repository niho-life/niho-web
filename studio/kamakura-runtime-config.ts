import { KAMAKURA_CMS_UPLOAD_ORIGIN } from "./kamakura-cms-contract.js";

declare global {
  interface Window {
    __NIHO_STUDIO_RUNTIME__?: { readonly kamakuraUploadOrigin?: unknown };
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
