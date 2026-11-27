import { KAMAKURA_CMS_UPLOAD_ORIGIN } from "./kamakura-cms-contract.js";

type MetaDocument = Pick<Document, "querySelector">;

/** Studio Worker が HTML に挿入した、直接アップロード先の環境別 origin を読む。 */
export function kamakuraUploadOrigin(documentRef: MetaDocument | undefined = typeof document === "undefined" ? undefined : document): string {
  if (!documentRef) return KAMAKURA_CMS_UPLOAD_ORIGIN;
  const value = documentRef.querySelector<HTMLMetaElement>('meta[name="niho-studio-upload-origin"]')?.getAttribute("content");
  if (!value) return KAMAKURA_CMS_UPLOAD_ORIGIN;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.origin === value && !url.username && !url.password && !url.search && !url.hash) return value;
  } catch { /* invalid runtime configuration falls back to the Production contract; Preview intents then fail closed */ }
  return KAMAKURA_CMS_UPLOAD_ORIGIN;
}
