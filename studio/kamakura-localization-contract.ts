import { KAMAKURA_CMS_IMAGE_TYPES, KAMAKURA_CMS_UPLOAD_ORIGIN, KAMAKURA_MEDIA_ORIGIN, isKamakuraCmsCollectionId, isKamakuraCmsItemId } from "./kamakura-cms-contract.js";
import { LOCALIZATION_LIMITS } from "../src/localization-workspace-model.js";
import { fail, keys, record } from "../src/validation-utils.js";

/**
 * 鎌倉サイトの翻訳を Studio の翻訳の画面（LocalizationWorkspace）から直す契約（kamakura-site#108 U3）。
 * Studio の BFF（studio/worker.ts）とブラウザの adapter（studio/kamakura-localization.ts）が同じ定数と parser を使う。
 * 応答の形は W1 の契約（docs/localization-workspace-contract.md・src/localization-workspace-model.ts の parser）のまま。
 */

/** ブラウザが呼ぶ同一 origin の BFF。 */
export const KAMAKURA_LOCALIZATION_BASE = "/api/projects/project-kamakura/sites/kamakura/localization";
/** BFF が service binding で呼ぶ鎌倉の Worker の prefix。 */
export const KAMAKURA_LOCALIZATION_UPSTREAM_PREFIX = "/internal/studio/localization";
/** 鎌倉の Worker の公開 origin（CMS の画像の直接 PUT 先と同じ）。訳す言語の画像の直接 PUT と、プレビューの枠はここにある。 */
export const KAMAKURA_LOCALIZATION_UPLOAD_ORIGIN = KAMAKURA_CMS_UPLOAD_ORIGIN;
export const KAMAKURA_LOCALIZATION_PREVIEW_ORIGIN = KAMAKURA_CMS_UPLOAD_ORIGIN;
/** プレビューの枠（鎌倉のビルドが書く静的なページ）。拡張子の有り無しのどちらでも届く。 */
const PREVIEW_PATHS: ReadonlySet<string> = new Set(["/_studio/localization-preview", "/_studio/localization-preview.html"]);
const UPLOAD_PATH = /^\/internal\/studio\/localization-upload\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const KAMAKURA_LOCALIZATION_IMAGE_TYPES: ReadonlySet<string> = KAMAKURA_CMS_IMAGE_TYPES;

export const KAMAKURA_LOCALIZATION_LIMITS = Object.freeze({
  /** 読み取り・公開・設定・アップロード開始の本文と、アップロード開始の応答。 */
  bodyBytes: 16 * 1024,
  /** 訳文の保存（command）の本文。鎌倉の Worker の上限 1 MiB から、BFF が足す actor の分を引く。 */
  commandBodyBytes: 1024 * 1024 - 4 * 1024,
  /** 上流の応答（概要・一覧・1 件・保存の結果・公開）。 */
  responseBytes: 4 * 1024 * 1024,
  /** プレビューの材料の応答（W1 の 1 回の上限 2 MiB と包みの分）。BFF は確かめずにこの上限つきで流す。 */
  previewResponseBytes: LOCALIZATION_LIMITS.previewBytes + 64 * 1024,
  /** 鎌倉の Worker の 413 が正。これは BFF・ブラウザの外側の上限。 */
  imageBytes: 50 * 1024 * 1024,
  uploadNameLength: 200
});

/** overview.preview.frameUrl が鎌倉の Worker のプレビューの枠か（CSP の frame-src に足す origin と合わせる）。 */
export function isKamakuraLocalizationPreviewFrame(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || value.includes("?") || value.includes("#")) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === "https:" && url.origin === KAMAKURA_LOCALIZATION_PREVIEW_ORIGIN && !url.username && !url.password && PREVIEW_PATHS.has(url.pathname);
}

export type KamakuraLocalizationUploadIntent = { readonly uploadUrl: string; readonly uploadToken: string; readonly uploadId: string };
/** POST uploads/intent の 201。uploadUrl は鎌倉の Worker の /internal/studio/localization-upload/<uploadId> だけ。 */
export function parseKamakuraLocalizationUploadIntent(input: unknown): KamakuraLocalizationUploadIntent {
  const value = record(input, "intent");
  keys(value, ["uploadUrl", "uploadToken", "uploadId"], "intent");
  const { uploadUrl, uploadToken, uploadId } = value;
  if (typeof uploadId !== "string" || !UUID.test(uploadId)) fail("intent.uploadId", "invalid upload id");
  if (typeof uploadToken !== "string" || !/^[A-Za-z0-9_.-]{1,4096}$/u.test(uploadToken)) fail("intent.uploadToken", "invalid upload token");
  if (typeof uploadUrl !== "string" || uploadUrl.length > 2048 || uploadUrl.includes("?") || uploadUrl.includes("#")) fail("intent.uploadUrl", "invalid upload URL");
  let url: URL;
  try { url = new URL(uploadUrl); } catch { fail("intent.uploadUrl", "invalid upload URL"); }
  const match = UPLOAD_PATH.exec(url.pathname);
  if (url.protocol !== "https:" || url.origin !== KAMAKURA_LOCALIZATION_UPLOAD_ORIGIN || url.username || url.password || !match || match[1]!.toLowerCase() !== uploadId.toLowerCase()) fail("intent.uploadUrl", "unexpected upload URL");
  return { uploadUrl: url.href, uploadToken, uploadId };
}

export type KamakuraLocalizationUploadRefusal = { readonly status: "forbidden" } | { readonly status: "not_found" } | { readonly status: "invalid"; readonly message: string };
/** POST uploads/intent の契約の結果（許可の 201 以外）。権限が無い・項目が無い・画像の項目ではない。 */
export function parseKamakuraLocalizationUploadRefusal(input: unknown): KamakuraLocalizationUploadRefusal {
  const value = record(input, "intent");
  if (value.status === "forbidden" || value.status === "not_found") { keys(value, ["status"], "intent"); return { status: value.status }; }
  keys(value, ["status", "message"], "intent");
  if (value.status !== "invalid") fail("intent.status", "invalid status");
  const message = value.message;
  if (typeof message !== "string" || !message.trim() || message.length > 400 || /[\u0000-\u001f\u007f]/u.test(message)) fail("intent.message", "invalid message");
  return { status: "invalid", message };
}

/** 訳す言語の画像に使える URL（鎌倉の公開画像の置き場の https・資格情報・query・fragment なし）。素材から選んだ画像に使う。 */
export function isKamakuraPublicImageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || /[\s\u0000-\u001f\u007f<>"'\\?#]/u.test(value)) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === "https:" && url.origin === KAMAKURA_MEDIA_ORIGIN && !url.username && !url.password && url.pathname.length > 1 && !url.pathname.startsWith("/cdn-cgi/");
}

/**
 * 翻訳の 1 件（itemKey）が CMS の項目なら、そのコレクションと項目の id。itemKey は鎌倉の翻訳の 1 件の id を base64url にしたもので、
 * CMS の項目は `cms:<コレクション>:<項目の id>`（kamakura-site の worker/README.md「Studio の翻訳 API の契約」）。
 * 固定ページ・共通部分などの原文はコードで管理しているので null。読めない値も null。
 */
export function kamakuraLocalizationCmsSource(itemKey: string): { readonly collectionId: string; readonly itemId: string } | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/u.test(itemKey)) return null;
  let text: string;
  try {
    const binary = atob(itemKey.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(itemKey.length / 4) * 4, "="));
    text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch { return null; }
  const match = /^cms:([^:]+):([^:]+)$/u.exec(text);
  const collectionId = match?.[1], itemId = match?.[2];
  if (!isKamakuraCmsCollectionId(collectionId) || !isKamakuraCmsItemId(itemId)) return null;
  return { collectionId, itemId };
}

/** CMS の 1 件から、同じ 1 件の翻訳画面の itemKey を作る。 */
export function kamakuraCmsLocalizationItemKey(collectionId: string, itemId: string): string | null {
  if (!isKamakuraCmsCollectionId(collectionId) || !isKamakuraCmsItemId(itemId)) return null;
  const canonical = `cms:${collectionId}:${itemId}`;
  if (canonical.length > 150) return null; // 鎌倉 Worker の itemIndex と同じ上限
  return btoa(canonical).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
