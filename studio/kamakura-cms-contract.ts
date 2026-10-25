import {
  isIsoTimestamp, parseCollectionItemSummary, parseCollectionListResult, parseCollectionSchemaResult,
  type CollectionDefinition, type CollectionFieldError, type CollectionItem, type CollectionItemSummary, type CollectionValue
} from "../src/collection-model.js";
import { DocumentValidationError, fail, record } from "../src/validation-utils.js";

/**
 * 鎌倉サイトの CMS（記事・サークル・会社）を Studio のコレクション画面から編集する契約。
 * Studio の BFF（studio/worker.ts）とブラウザの adapter（studio/kamakura-cms.ts）が同じ parser で応答を確かめる。
 * 応答の形は src/collection-model.ts の型と同じ。項目の key は鎌倉の Worker が返す読みやすい名前だけ。
 */

export const KAMAKURA_CMS_PROJECT_ID = "project-kamakura" as const;
export const KAMAKURA_CMS_SITE_ID = "kamakura" as const;
/** ブラウザが呼ぶ同一 origin の BFF。 */
export const KAMAKURA_CMS_BASE = "/api/projects/project-kamakura/sites/kamakura/cms";
/** BFF が service binding で呼ぶ鎌倉の Worker の prefix。 */
export const KAMAKURA_CMS_UPSTREAM_PREFIX = "/internal/studio/cms";
/** 画像本体を直接 PUT する先（鎌倉の Worker）。 */
export const KAMAKURA_CMS_UPLOAD_ORIGIN = "https://next-kamakura.niho.life";
const UPLOAD_PATH = /^\/internal\/studio\/cms-upload\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;
/** 鎌倉の公開画像の置き場（R2 MEDIA の公開 origin）。/cdn-cgi/image で幅を指定できる。 */
export const KAMAKURA_MEDIA_ORIGIN = "https://kamakura-media.niho.life";
export const KAMAKURA_CMS_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]);

export const KAMAKURA_CMS_LIMITS = Object.freeze({
  /** 上流の応答（schema・一覧・項目・保存結果・409 の項目）。 */
  responseBytes: 3 * 1024 * 1024,
  /** 下書きの保存の本文。 */
  draftBodyBytes: 2 * 1024 * 1024,
  /** そのほかの本文と、アップロード開始の応答。 */
  bodyBytes: 16 * 1024,
  valueKeys: 100,
  /** 1 つの値の文字数（UTF-16）。本文（richText）を含む。本文全体は draftBodyBytes でも抑える。 */
  stringLength: 1_000_000,
  arrayEntries: 200,
  arrayEntryLength: 200,
  /** 422 の errors をブラウザへ渡す数。 */
  errors: 50,
  /** 鎌倉の Worker の 413 が正。これは BFF・ブラウザの外側の上限。 */
  imageBytes: 50 * 1024 * 1024,
  uploadNameLength: 200
});

export const KAMAKURA_CMS_COLLECTION_ID = /^[a-z][a-z0-9-]{0,39}$/u;
export const KAMAKURA_CMS_VALUE_KEY = /^[a-z][A-Za-z0-9]{0,63}$/u;
const ITEM_ID = /^[A-Za-z0-9_][A-Za-z0-9._~-]{0,127}$/u;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isKamakuraCmsCollectionId(value: unknown): value is string {
  return typeof value === "string" && KAMAKURA_CMS_COLLECTION_ID.test(value);
}
export function isKamakuraCmsItemId(value: unknown): value is string {
  return typeof value === "string" && ITEM_ID.test(value) && !RESERVED.has(value);
}
/** 不透明な version。collection-model の項目の version と同じ条件（1〜200 字・制御文字なし・空白だけは不可）。 */
export function isKamakuraCmsVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && !!value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}
/** 1 行の短い文字列（題名・ファイル名など）。 */
export function isKamakuraCmsLine(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum && !!value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}
/** 予約の日時。タイムゾーン付きの ISO を UTC（Z）にそろえる。読めなければ null。 */
export function normalizeKamakuraCmsTimestamp(value: unknown): string | null {
  if (!isIsoTimestamp(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** 契約に合わない応答。メッセージには値を入れない。 */
export class KamakuraCmsContractError extends Error {
  readonly code = "upstream_contract_invalid" as const;
  constructor(readonly path: string) {
    super(`Kamakura CMS response does not match the contract at ${path}`);
    this.name = "KamakuraCmsContractError";
  }
}

function guarded<T>(parse: () => T): T {
  try { return parse(); }
  catch (error) {
    if (error instanceof DocumentValidationError) throw new KamakuraCmsContractError(error.path);
    throw error;
  }
}

function exact(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(value).sort(), keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) fail(path, "unexpected fields");
}

function parseValuesAt(input: unknown, path: string): Record<string, CollectionValue> {
  const source = record(input, path);
  const entries = Object.keys(source);
  if (entries.length > KAMAKURA_CMS_LIMITS.valueKeys) fail(path, "too many values");
  const result: Record<string, CollectionValue> = {};
  for (const key of entries) {
    if (!KAMAKURA_CMS_VALUE_KEY.test(key)) fail(path, "invalid value key");
    const value = source[key], at = `${path}.${key}`;
    if (value === null) result[key] = null;
    else if (typeof value === "string") {
      if (value.length > KAMAKURA_CMS_LIMITS.stringLength || /[\u0000\u000b\u000c]/u.test(value)) fail(at, "invalid string");
      result[key] = value;
    } else if (Array.isArray(value)) {
      if (value.length > KAMAKURA_CMS_LIMITS.arrayEntries) fail(at, "too many entries");
      const list = value.map((entry, index) => {
        if (!isKamakuraCmsLine(entry, KAMAKURA_CMS_LIMITS.arrayEntryLength)) fail(`${at}[${index}]`, "invalid entry");
        return entry;
      });
      if (new Set(list).size !== list.length) fail(at, "duplicate entry");
      result[key] = list;
    } else fail(at, "expected string, null or string[]");
  }
  return result;
}

/**
 * 項目の値（definition を使わない形の確かめ）。key は読みやすい名前（^[a-z][A-Za-z0-9]{0,63}$）で 100 個まで、
 * 値は string（100 万字まで）・null・string[]（200 個まで・各 1〜200 字・重複なし）。BFF は下書きの本文にも使う。
 */
export function parseKamakuraCmsValues(input: unknown, path = "values"): Record<string, CollectionValue> {
  return guarded(() => parseValuesAt(input, path));
}

function parseItemAt(input: unknown, path: string, expectedId?: string): CollectionItem {
  const source = record(input, path);
  if (!Object.hasOwn(source, "version") || !Object.hasOwn(source, "values")) fail(path, "missing version or values");
  const { version, values, ...summarySource } = source;
  const summary: CollectionItemSummary = parseCollectionItemSummary(summarySource, path);
  if (!isKamakuraCmsVersion(version)) fail(`${path}.version`, "invalid version");
  if (!isKamakuraCmsItemId(summary.id)) fail(`${path}.id`, "invalid item id");
  if (expectedId !== undefined && summary.id !== expectedId) fail(`${path}.id`, "item identity mismatch");
  return { ...summary, version, values: parseValuesAt(values, `${path}.values`) };
}

/** 項目 1 件（summary・version・values）。expectedId を渡すと id の一致も確かめる。 */
export function parseKamakuraCmsItem(input: unknown, expectedId?: string): CollectionItem {
  return guarded(() => parseItemAt(input, "item", expectedId));
}

function checkSchemaNames(collections: readonly CollectionDefinition[]): void {
  collections.forEach((definition, index) => {
    if (!KAMAKURA_CMS_COLLECTION_ID.test(definition.id)) fail(`schema.collections[${index}].id`, "invalid collection id");
    definition.fields.forEach((field, fieldIndex) => {
      if (!KAMAKURA_CMS_VALUE_KEY.test(field.key)) fail(`schema.collections[${index}].fields[${fieldIndex}].key`, "invalid field key");
    });
  });
}

/** GET schema の 200。`{ status: "ready", collections }` だけ（forbidden は BFF が返すので上流からは受けない）。 */
export function parseKamakuraCmsSchema(input: unknown): { readonly status: "ready"; readonly collections: readonly CollectionDefinition[] } {
  return guarded(() => {
    if (record(input, "schema").status !== "ready") fail("schema.status", "invalid status");
    const result = parseCollectionSchemaResult(input);
    if (result.status !== "ready") fail("schema.status", "invalid status");
    checkSchemaNames(result.collections);
    return result;
  });
}

/** GET collections/:col/items の 200。 */
export function parseKamakuraCmsList(input: unknown, collectionId: string): { readonly status: "ready"; readonly collectionId: string; readonly items: readonly CollectionItemSummary[] } {
  return guarded(() => {
    if (record(input, "list").status !== "ready") fail("list.status", "invalid status");
    const result = parseCollectionListResult(input, collectionId);
    if (result.status !== "ready") fail("list.status", "invalid status");
    result.items.forEach((item, index) => { if (!isKamakuraCmsItemId(item.id)) fail(`list.items[${index}].id`, "invalid item id"); });
    return result;
  });
}

export type KamakuraCmsItemStatus = "ready" | "created" | "saved" | "publishing";
/** 項目を持つ成功の応答（`{ status, item }`）。 */
export function parseKamakuraCmsItemEnvelope<S extends KamakuraCmsItemStatus>(input: unknown, status: S, expectedId?: string): { readonly status: S; readonly item: CollectionItem } {
  return guarded(() => {
    const value = record(input, "response");
    exact(value, ["status", "item"], "response");
    if (value.status !== status) fail("response.status", "unexpected status");
    return { status, item: parseItemAt(value.item, "response.item", expectedId) };
  });
}

/** POST …/remove の 200。 */
export function parseKamakuraCmsRemoved(input: unknown): { readonly status: "removed" } {
  return guarded(() => {
    const value = record(input, "response");
    exact(value, ["status"], "response");
    if (value.status !== "removed") fail("response.status", "unexpected status");
    return { status: "removed" as const };
  });
}

/** 409 の本文 `{ error: "conflict", item }`。item はほかの人が保存した最新。 */
export function parseKamakuraCmsConflict(input: unknown, expectedId: string): { readonly error: "conflict"; readonly item: CollectionItem } {
  return guarded(() => {
    const value = record(input, "conflict");
    exact(value, ["error", "item"], "conflict");
    if (value.error !== "conflict") fail("conflict.error", "unexpected error");
    return { error: "conflict" as const, item: parseItemAt(value.item, "conflict.item", expectedId) };
  });
}

/** 422 の本文 `{ error: "invalid", errors: [{ field, message }] }`。ブラウザへは先頭の 50 件だけ渡す。 */
export function parseKamakuraCmsInvalid(input: unknown): { readonly error: "invalid"; readonly errors: readonly CollectionFieldError[] } {
  return guarded(() => {
    const value = record(input, "invalid");
    exact(value, ["error", "errors"], "invalid");
    if (value.error !== "invalid") fail("invalid.error", "unexpected error");
    if (!Array.isArray(value.errors) || value.errors.length === 0 || value.errors.length > 200) fail("invalid.errors", "expected 1 to 200 errors");
    const errors = value.errors.slice(0, KAMAKURA_CMS_LIMITS.errors).map((entry: unknown, index: number) => {
      const error = record(entry, `invalid.errors[${index}]`);
      exact(error, ["field", "message"], `invalid.errors[${index}]`);
      const field = error.field, message = error.message;
      // field は項目の key（画面はその項目の下に出す）か、それ以外（"" など。画面の上にまとめて出す）。
      if (typeof field !== "string" || field.length > 80 || /[\u0000-\u001f\u007f]/u.test(field)) fail(`invalid.errors[${index}].field`, "invalid field");
      if (!isKamakuraCmsLine(message, 400)) fail(`invalid.errors[${index}].message`, "invalid message");
      return { field, message };
    });
    return { error: "invalid" as const, errors };
  });
}

export type KamakuraCmsUploadIntent = { readonly uploadUrl: string; readonly uploadToken: string; readonly uploadId: string };
/** POST uploads/intent の 201。uploadUrl は鎌倉の Worker の /internal/studio/cms-upload/<uploadId> だけ。 */
export function parseKamakuraCmsUploadIntent(input: unknown): KamakuraCmsUploadIntent {
  return guarded(() => {
    const value = record(input, "intent");
    exact(value, ["uploadUrl", "uploadToken", "uploadId"], "intent");
    const { uploadUrl, uploadToken, uploadId } = value;
    if (typeof uploadId !== "string" || !UUID.test(uploadId)) fail("intent.uploadId", "invalid upload id");
    if (typeof uploadToken !== "string" || !/^[\x21-\x7e]{1,4096}$/u.test(uploadToken)) fail("intent.uploadToken", "invalid upload token");
    if (typeof uploadUrl !== "string" || uploadUrl.length > 2048) fail("intent.uploadUrl", "invalid upload URL");
    let url: URL;
    try { url = new URL(uploadUrl); } catch { fail("intent.uploadUrl", "invalid upload URL"); }
    const match = UPLOAD_PATH.exec(url.pathname);
    if (url.protocol !== "https:" || url.origin !== KAMAKURA_CMS_UPLOAD_ORIGIN || url.username || url.password || url.search || url.hash || uploadUrl.includes("?") || uploadUrl.includes("#") || !match || match[1]!.toLowerCase() !== uploadId.toLowerCase()) fail("intent.uploadUrl", "unexpected upload URL");
    return { uploadUrl: url.href, uploadToken, uploadId };
  });
}

export type KamakuraCmsUploaded = { readonly url: string; readonly width: number; readonly height: number };
/** 直接 PUT の 201 `{ url, width, height }`。url は公開画像の置き場の /uploads/ の下だけ。 */
export function parseKamakuraCmsUploadResult(input: unknown): KamakuraCmsUploaded {
  return guarded(() => {
    const value = record(input, "upload");
    exact(value, ["url", "width", "height"], "upload");
    const { url, width, height } = value;
    if (typeof url !== "string" || url.length > 2048 || /[\s\u0000-\u001f\u007f<>"'\\]/u.test(url)) fail("upload.url", "invalid URL");
    let parsed: URL;
    try { parsed = new URL(url); } catch { fail("upload.url", "invalid URL"); }
    if (parsed.protocol !== "https:" || parsed.origin !== KAMAKURA_MEDIA_ORIGIN || parsed.username || parsed.password || parsed.search || parsed.hash || url.includes("?") || url.includes("#") || !parsed.pathname.startsWith("/uploads/")) fail("upload.url", "unexpected URL");
    for (const [name, size] of [["width", width], ["height", height]] as const) {
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > 100_000) fail(`upload.${name}`, "invalid size");
    }
    return { url: parsed.href, width: width as number, height: height as number };
  });
}
