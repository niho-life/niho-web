import { KAMAKURA_CMS_UPLOAD_ORIGIN } from "./kamakura-cms-contract.js";

const UPLOAD_PATH = /^\/internal\/studio\/asset-upload\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;

export function parseKamakuraAssetUploadIntent(input: unknown, trustedOrigin = KAMAKURA_CMS_UPLOAD_ORIGIN): { readonly uploadUrl: string; readonly uploadToken: string; readonly assetId: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)
    || Object.keys(input).sort().join(",") !== "assetId,uploadToken,uploadUrl") throw new Error("素材 API の応答が正しくありません。");
  const { uploadUrl, uploadToken, assetId } = input as Record<string, unknown>;
  if (typeof uploadUrl !== "string" || uploadUrl.length > 2048 || uploadUrl.includes("?") || uploadUrl.includes("#")
    || typeof uploadToken !== "string" || uploadToken.length < 1 || uploadToken.length > 4096 || /[\u0000-\u001f\u007f]/u.test(uploadToken)
    || typeof assetId !== "string") throw new Error("アップロード開始情報が正しくありません。");
  const url = new URL(uploadUrl);
  const match = UPLOAD_PATH.exec(url.pathname);
  if (url.protocol !== "https:" || url.origin !== trustedOrigin || url.username || url.password || !match
    || match[1]!.toLowerCase() !== assetId.toLowerCase()) throw new Error("アップロード先が正しくありません。");
  return { uploadUrl: url.href, uploadToken, assetId };
}
