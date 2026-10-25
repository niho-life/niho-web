import { DocumentValidationError, fail, keys, record, string } from "./validation-utils.js";

/* ---------- 型（React 不要） ---------- */

export type CollectionIcon = "document" | "people" | "person" | "tag";
export type CollectionOrdering = "publishedAt" | "manual";
export type CollectionCapabilities = {
  readonly create: boolean;
  readonly duplicate: boolean;
  readonly remove: boolean;
  readonly unpublish: boolean;
  readonly schedule: boolean;
};
export type CollectionFieldPlacement = "main" | "side";
type FieldBase = {
  readonly key: string;
  readonly label: string;
  readonly hint?: string;
  readonly required?: boolean;
  readonly placement: CollectionFieldPlacement;
};
export type CollectionOption = { readonly id: string; readonly label: string };
export type CollectionTextField = FieldBase & { readonly type: "text"; readonly maxLength?: number; readonly placeholder?: string };
export type CollectionLongTextField = FieldBase & { readonly type: "longText"; readonly rows: number; readonly maxLength?: number };
export type CollectionRichTextField = FieldBase & { readonly type: "richText" };
export type CollectionUrlField = FieldBase & { readonly type: "url"; readonly placeholder?: string };
export type CollectionImageField = FieldBase & { readonly type: "image"; readonly shape?: "rect" | "round" };
export type CollectionSelectField = FieldBase & { readonly type: "select"; readonly multiple: boolean; readonly options: readonly CollectionOption[] };
/** 候補は listItems(collectionId) の題名。 */
export type CollectionReferenceField = FieldBase & { readonly type: "reference"; readonly multiple: boolean; readonly collectionId: string };
export type CollectionTagsField = FieldBase & { readonly type: "tags" };
export type CollectionDatetimeField = FieldBase & { readonly type: "datetime" };
export type CollectionSlugField = FieldBase & { readonly type: "slug" };
export type CollectionField =
  | CollectionTextField | CollectionLongTextField | CollectionRichTextField | CollectionUrlField | CollectionImageField
  | CollectionSelectField | CollectionReferenceField | CollectionTagsField | CollectionDatetimeField | CollectionSlugField;
export type CollectionFieldType = CollectionField["type"];

export type CollectionDefinition = {
  readonly id: string;
  readonly label: string;
  readonly addLabel: string;
  readonly icon?: CollectionIcon;
  readonly ordering: CollectionOrdering;
  /** 公開時のアドレスの前（例 "/posts/"）。アドレス欄の表示に使う。 */
  readonly pathPrefix: string | null;
  readonly titleField: string;
  readonly slugField: string | null;
  readonly imageField: string | null;
  readonly subtitleField: string | null;
  readonly capabilities: CollectionCapabilities;
  /** 並び順どおりに出す。 */
  readonly fields: readonly CollectionField[];
};

/** changed = 公開中で、まだ出していない変更がある。publishing = サイトの作り直し待ち（反映中）。 */
export type CollectionItemStatus = "draft" | "published" | "changed" | "publishing" | "scheduled";
export type CollectionItemSummary = {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly imageUrl: string | null;
  /** 公開中（または公開する予定）のサイト内のパス。一覧の題名の下に出す。 */
  readonly path: string | null;
  readonly status: CollectionItemStatus;
  readonly publishedAt: string | null;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly scheduledAt: string | null;
  readonly publishFailed: boolean;
  readonly order: number | null;
};
/** text・longText・url・slug・richText は string、image・datetime は string | null、select・reference・tags は string[]。 */
export type CollectionValue = string | null | readonly string[];
export type CollectionValues = Readonly<Record<string, CollectionValue>>;
export type CollectionItem = CollectionItemSummary & { readonly version: string; readonly values: CollectionValues };
export type CollectionFieldError = { readonly field: string; readonly message: string };

export type CollectionForbidden = { readonly status: "forbidden" };
export type CollectionNotFound = { readonly status: "not_found" };
export type CollectionConflict = { readonly status: "conflict"; readonly item: CollectionItem };
export type CollectionInvalid = { readonly status: "invalid"; readonly errors: readonly CollectionFieldError[] };
export type CollectionSchemaResult = { readonly status: "ready"; readonly collections: readonly CollectionDefinition[] } | CollectionForbidden;
export type CollectionListResult = { readonly status: "ready"; readonly collectionId: string; readonly items: readonly CollectionItemSummary[] } | CollectionForbidden;
export type CollectionItemResult = { readonly status: "ready"; readonly item: CollectionItem } | CollectionNotFound | CollectionForbidden;
export type CollectionCreateResult = { readonly status: "created"; readonly item: CollectionItem } | CollectionNotFound | CollectionForbidden;
export type CollectionSaveResult = { readonly status: "saved"; readonly item: CollectionItem } | CollectionConflict | CollectionInvalid | CollectionNotFound | CollectionForbidden;
export type CollectionPublishResult = { readonly status: "published" | "publishing"; readonly item: CollectionItem } | CollectionConflict | CollectionInvalid | CollectionNotFound | CollectionForbidden;
export type CollectionRemoveResult = { readonly status: "removed" } | CollectionConflict | CollectionNotFound | CollectionForbidden;
export type CollectionUploadRejectReason = "type" | "size" | "permission" | "invalid";
export type CollectionUploadResult =
  | { readonly status: "uploaded"; readonly url: string; readonly width?: number; readonly height?: number }
  | { readonly status: "rejected"; readonly reason: CollectionUploadRejectReason };

export type CollectionTarget = { readonly collectionId: string; readonly itemId: string };
export type CollectionVersionedTarget = CollectionTarget & { readonly version: string };

/**
 * ホストが実装する adapter。すべての戻り値は unknown として受け取り、parser で検証する。
 * 認証・認可・保存・公開・画像の置き場・HTML の最終的な無害化はホストの責務。
 * 権限が無いときは { status: "forbidden" } を返せる（画面は情報を消して権限が無いと出す）。
 * 任意の操作は、メソッドが無いか definition.capabilities が false のとき画面に出さない。
 */
export interface CollectionAdapter {
  loadSchema(signal: AbortSignal): Promise<unknown>;
  listItems(input: { readonly collectionId: string }, signal: AbortSignal): Promise<unknown>;
  loadItem(input: CollectionTarget, signal: AbortSignal): Promise<unknown>;
  /** 下書きを保存する。values は definition.fields の全部の key を持つ。fields に無い値はホストが保持する。 */
  saveDraft(input: CollectionVersionedTarget & { readonly values: CollectionValues }, signal: AbortSignal): Promise<unknown>;
  publish(input: CollectionVersionedTarget, signal: AbortSignal): Promise<unknown>;
  uploadImage(input: { readonly collectionId: string; readonly file: File }, signal: AbortSignal): Promise<unknown>;
  /** 下書きとして作る（capabilities.create）。 */
  createItem?(input: { readonly collectionId: string }, signal: AbortSignal): Promise<unknown>;
  /** 公開中の内容に戻す（状態が changed のとき）。 */
  discardDraft?(input: CollectionVersionedTarget, signal: AbortSignal): Promise<unknown>;
  unpublish?(input: CollectionVersionedTarget, signal: AbortSignal): Promise<unknown>;
  duplicate?(input: CollectionTarget, signal: AbortSignal): Promise<unknown>;
  remove?(input: CollectionVersionedTarget, signal: AbortSignal): Promise<unknown>;
  schedule?(input: CollectionVersionedTarget & { readonly at: string }, signal: AbortSignal): Promise<unknown>;
  cancelSchedule?(input: CollectionVersionedTarget, signal: AbortSignal): Promise<unknown>;
  /** 一覧の小さい画像・項目の画像の表示用 URL。無ければ url のまま。 */
  imageUrl?(url: string, width: number): string;
  /** プレビューを別タブで開く URL（保存済みの下書き）。null なら出さない。 */
  previewUrl?(collectionId: string, item: CollectionItem): string | null;
  /** 本文（richText）の画像で、https 以外（同じサイトの "/" から始まる path）も残してよいか。既定は https だけ。 */
  isRichTextImageAllowed?(src: string): boolean;
}

/* ---------- 小さな検証 ---------- */

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const ITEM_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9._~-]*$/;
export const COLLECTION_SLUG_PATTERN = /^[A-Za-z0-9_-]+$/;

function key(value: unknown, path: string): string {
  const result = string(value, path, 80);
  if (!KEY_RE.test(result) || RESERVED_KEYS.has(result)) fail(path, "invalid key");
  return result;
}
function itemId(value: unknown, path: string): string {
  const result = string(value, path, 128);
  if (!ITEM_ID_RE.test(result) || RESERVED_KEYS.has(result)) fail(path, "invalid item id");
  return result;
}
function label(value: unknown, path: string, max = 120): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(path, "invalid label");
  return value;
}
/** 1 行の文字列（空でもよい）。 */
function lineText(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail(path, "invalid text");
  return value;
}
function nullableLine(value: unknown, path: string, max: number): string | null {
  return value === null ? null : lineText(value, path, max);
}
function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "expected a boolean");
  return value;
}
function optional<T>(source: Record<string, unknown>, name: string, parse: (value: unknown) => T): T | undefined {
  return source[name] === undefined ? undefined : parse(source[name]);
}
function positiveInt(value: unknown, path: string, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) fail(path, "expected a positive integer");
  return value;
}
function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(path, "expected an array");
  return value;
}

/** タイムゾーン付きの ISO 8601（例 2026-10-20T09:00:00Z / 2026-10-20T18:00:00+09:00）。 */
export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  if (!match) return false;
  const [, y, mo, d, h, mi, s = "0", , oh, om] = match;
  const year = Number(y), month = Number(mo), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  if (month < 1 || month > 12 || day < 1 || day > days) return false;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return false;
  if (oh !== undefined && (Number(oh) > 23 || Number(om) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}
function timestamp(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (!isIsoTimestamp(value)) fail(path, "expected an ISO timestamp with timezone");
  return value;
}
/** http / https の絶対 URL（資格情報なし）。url の項目の値の確かめに使う。 */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || /[\s\u0000-\u001f\u007f<>"'\\]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}
/** 画像の表示に使ってよい URL（http・https の絶対 URL、または "/" から始まる同じサイトの path）。 */
export function isDisplayableImageUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\s\u0000-\u001f\u007f<>"'\\]/u.test(value)) return false;
  if (value.startsWith("/")) return !value.startsWith("//");
  return isHttpUrl(value);
}

/* ---------- 定義（loadSchema） ---------- */

const fieldKeys: Record<CollectionFieldType, readonly string[]> = {
  text: ["maxLength", "placeholder"],
  longText: ["rows", "maxLength"],
  richText: [],
  url: ["placeholder"],
  image: ["shape"],
  select: ["multiple", "options"],
  reference: ["multiple", "collectionId"],
  tags: [],
  datetime: [],
  slug: [],
};
const baseKeys = ["key", "label", "hint", "required", "placement", "type"];

function parseField(input: unknown, path: string): CollectionField {
  const source = record(input, path);
  const type = source.type;
  if (typeof type !== "string" || !Object.hasOwn(fieldKeys, type)) fail(`${path}.type`, "unknown field type");
  const fieldType = type as CollectionFieldType;
  keys(source, [...baseKeys, ...fieldKeys[fieldType]], path);
  const placement = source.placement;
  if (placement !== "main" && placement !== "side") fail(`${path}.placement`, "invalid placement");
  const base = {
    key: key(source.key, `${path}.key`),
    label: label(source.label, `${path}.label`),
    placement,
    ...(source.hint === undefined ? {} : { hint: label(source.hint, `${path}.hint`, 600) }),
    ...(source.required === undefined ? {} : { required: bool(source.required, `${path}.required`) }),
  } as const;
  const maxLength = optional(source, "maxLength", (value) => positiveInt(value, `${path}.maxLength`, 1_000_000));
  const placeholder = optional(source, "placeholder", (value) => label(value, `${path}.placeholder`, 200));
  switch (fieldType) {
    case "text": return { ...base, type: "text", ...(maxLength === undefined ? {} : { maxLength }), ...(placeholder === undefined ? {} : { placeholder }) };
    case "longText": return { ...base, type: "longText", rows: positiveInt(source.rows, `${path}.rows`, 40), ...(maxLength === undefined ? {} : { maxLength }) };
    case "url": return { ...base, type: "url", ...(placeholder === undefined ? {} : { placeholder }) };
    case "image": {
      const shape = source.shape;
      if (shape !== undefined && shape !== "rect" && shape !== "round") fail(`${path}.shape`, "invalid image shape");
      return { ...base, type: "image", ...(shape === undefined ? {} : { shape }) };
    }
    case "select": {
      const options = array(source.options, `${path}.options`, 200).map((inputOption, index) => {
        const option = record(inputOption, `${path}.options[${index}]`);
        keys(option, ["id", "label"], `${path}.options[${index}]`);
        return { id: key(option.id, `${path}.options[${index}].id`), label: label(option.label, `${path}.options[${index}].label`) };
      });
      if (!options.length) fail(`${path}.options`, "select needs options");
      if (new Set(options.map((option) => option.id)).size !== options.length) fail(`${path}.options`, "duplicate option");
      return { ...base, type: "select", multiple: bool(source.multiple, `${path}.multiple`), options };
    }
    case "reference": return { ...base, type: "reference", multiple: bool(source.multiple, `${path}.multiple`), collectionId: key(source.collectionId, `${path}.collectionId`) };
    case "richText": return { ...base, type: "richText" };
    case "tags": return { ...base, type: "tags" };
    case "datetime": return { ...base, type: "datetime" };
    case "slug": return { ...base, type: "slug" };
  }
}

function fieldRef(value: unknown, fields: readonly CollectionField[], types: readonly CollectionFieldType[] | null, path: string, nullable: boolean): string | null {
  if (value === null && nullable) return null;
  const name = key(value, path), field = fields.find((candidate) => candidate.key === name);
  if (!field) fail(path, "unknown field");
  if (types && !types.includes(field.type)) fail(path, "field type does not fit");
  return name;
}

function parseDefinition(input: unknown, path: string): CollectionDefinition {
  const source = record(input, path);
  keys(source, ["id", "label", "addLabel", "icon", "ordering", "pathPrefix", "titleField", "slugField", "imageField", "subtitleField", "capabilities", "fields"], path);
  const fields = array(source.fields, `${path}.fields`, 100).map((field, index) => parseField(field, `${path}.fields[${index}]`));
  if (!fields.length) fail(`${path}.fields`, "a collection needs fields");
  if (new Set(fields.map((field) => field.key)).size !== fields.length) fail(`${path}.fields`, "duplicate field key");
  const icon = source.icon;
  if (icon !== undefined && !["document", "people", "person", "tag"].includes(icon as string)) fail(`${path}.icon`, "invalid icon");
  const ordering = source.ordering;
  if (ordering !== "publishedAt" && ordering !== "manual") fail(`${path}.ordering`, "invalid ordering");
  const pathPrefix = source.pathPrefix === null ? null : lineText(source.pathPrefix, `${path}.pathPrefix`, 200);
  if (pathPrefix !== null && (!pathPrefix.startsWith("/") || pathPrefix.startsWith("//") || /[\s?#]/u.test(pathPrefix))) fail(`${path}.pathPrefix`, "invalid path prefix");
  const capabilitySource = record(source.capabilities, `${path}.capabilities`);
  const capabilityNames = ["create", "duplicate", "remove", "unpublish", "schedule"] as const;
  keys(capabilitySource, capabilityNames, `${path}.capabilities`);
  const capabilities = Object.fromEntries(capabilityNames.map((name) => [name, bool(capabilitySource[name], `${path}.capabilities.${name}`)])) as unknown as CollectionCapabilities;
  return {
    id: key(source.id, `${path}.id`),
    label: label(source.label, `${path}.label`, 80),
    addLabel: label(source.addLabel, `${path}.addLabel`, 40),
    ...(icon === undefined ? {} : { icon: icon as CollectionIcon }),
    ordering,
    pathPrefix,
    titleField: fieldRef(source.titleField, fields, ["text"], `${path}.titleField`, false)!,
    slugField: fieldRef(source.slugField, fields, ["slug"], `${path}.slugField`, true),
    imageField: fieldRef(source.imageField, fields, ["image"], `${path}.imageField`, true),
    subtitleField: fieldRef(source.subtitleField, fields, null, `${path}.subtitleField`, true),
    capabilities,
    fields,
  };
}

export function parseCollectionSchemaResult(input: unknown): CollectionSchemaResult {
  const value = record(input, "schema");
  if (value.status === "forbidden") { keys(value, ["status"], "schema"); return { status: "forbidden" }; }
  keys(value, ["status", "collections"], "schema");
  if (value.status !== "ready") fail("schema.status", "invalid status");
  const collections = array(value.collections, "schema.collections", 50).map((definition, index) => parseDefinition(definition, `schema.collections[${index}]`));
  const ids = new Set(collections.map((definition) => definition.id));
  if (ids.size !== collections.length) fail("schema.collections", "duplicate collection");
  collections.forEach((definition, index) => definition.fields.forEach((field, fieldIndex) => {
    if (field.type === "reference" && !ids.has(field.collectionId)) fail(`schema.collections[${index}].fields[${fieldIndex}].collectionId`, "unknown collection");
  }));
  return { status: "ready", collections };
}

/* ---------- 項目（listItems・loadItem ほか） ---------- */

const statuses: readonly CollectionItemStatus[] = ["draft", "published", "changed", "publishing", "scheduled"];
const summaryKeys = ["id", "title", "subtitle", "imageUrl", "path", "status", "publishedAt", "updatedAt", "updatedBy", "scheduledAt", "publishFailed", "order"];

function parseSummaryFields(source: Record<string, unknown>, path: string): CollectionItemSummary {
  const status = source.status;
  if (!statuses.includes(status as CollectionItemStatus)) fail(`${path}.status`, "invalid status");
  const scheduledAt = timestamp(source.scheduledAt, `${path}.scheduledAt`);
  if (status === "scheduled" && scheduledAt === null) fail(`${path}.scheduledAt`, "scheduled item needs scheduledAt");
  const itemPath = nullableLine(source.path, `${path}.path`, 2048);
  if (itemPath !== null && (!itemPath.startsWith("/") || itemPath.startsWith("//"))) fail(`${path}.path`, "path must start with /");
  const order = source.order;
  if (order !== null && (typeof order !== "number" || !Number.isFinite(order))) fail(`${path}.order`, "expected a finite number or null");
  return {
    id: itemId(source.id, `${path}.id`),
    title: lineText(source.title, `${path}.title`, 1000),
    subtitle: nullableLine(source.subtitle, `${path}.subtitle`, 1000),
    imageUrl: nullableLine(source.imageUrl, `${path}.imageUrl`, 2048),
    path: itemPath,
    status: status as CollectionItemStatus,
    publishedAt: timestamp(source.publishedAt, `${path}.publishedAt`),
    updatedAt: timestamp(source.updatedAt, `${path}.updatedAt`),
    updatedBy: nullableLine(source.updatedBy, `${path}.updatedBy`, 200),
    scheduledAt,
    publishFailed: bool(source.publishFailed, `${path}.publishFailed`),
    order: order as number | null,
  };
}
export function parseCollectionItemSummary(input: unknown, path = "item"): CollectionItemSummary {
  const source = record(input, path);
  keys(source, summaryKeys, path);
  return parseSummaryFields(source, path);
}

/** 項目の値を definition の形にそろえる。無い key は空の値にし、fields に無い key は捨てる。型が違えば例外。 */
export function parseCollectionValues(input: unknown, definition: CollectionDefinition, path = "values"): CollectionValues {
  const source = record(input, path);
  const result: Record<string, CollectionValue> = {};
  for (const field of definition.fields) {
    const raw = Object.hasOwn(source, field.key) ? source[field.key] : undefined, at = `${path}.${field.key}`;
    switch (field.type) {
      case "text": case "url": case "slug": result[field.key] = raw === undefined || raw === null ? "" : lineText(raw, at, 20_000); break;
      case "longText": result[field.key] = raw === undefined || raw === null ? "" : string(raw, at, 200_000); break;
      case "richText": result[field.key] = raw === undefined || raw === null ? "" : string(raw, at, 2_000_000); break;
      case "image": result[field.key] = raw === undefined || raw === null || raw === "" ? null : lineText(raw, at, 2048); break;
      case "datetime": result[field.key] = raw === undefined || raw === null || raw === "" ? null : timestamp(raw, at); break;
      case "select": case "reference": case "tags": {
        const list = raw === undefined || raw === null ? [] : array(raw, at, 500).map((entry, index) =>
          field.type === "tags" ? label(entry, `${at}[${index}]`, 200) : field.type === "select" ? key(entry, `${at}[${index}]`) : itemId(entry, `${at}[${index}]`));
        if (new Set(list).size !== list.length) fail(at, "duplicate value");
        if (field.type !== "tags" && !field.multiple && list.length > 1) fail(at, "single choice has many values");
        result[field.key] = list;
        break;
      }
    }
  }
  return result;
}

export function parseCollectionItem(input: unknown, definition: CollectionDefinition, path = "item"): CollectionItem {
  const source = record(input, path);
  keys(source, [...summaryKeys, "version", "values"], path);
  return { ...parseSummaryFields(source, path), version: label(source.version, `${path}.version`, 200), values: parseCollectionValues(source.values, definition, `${path}.values`) };
}

function expectId(item: CollectionItem, expected: string | undefined, path: string): CollectionItem {
  if (expected !== undefined && item.id !== expected) fail(path, "item identity mismatch");
  return item;
}
function common(value: Record<string, unknown>, path: string): CollectionForbidden | CollectionNotFound | null {
  if (value.status === "forbidden" || value.status === "not_found") { keys(value, ["status"], path); return { status: value.status }; }
  return null;
}
function withItem(value: Record<string, unknown>, definition: CollectionDefinition, itemIdExpected: string | undefined, path: string): CollectionItem {
  keys(value, ["status", "item"], path);
  return expectId(parseCollectionItem(value.item, definition, `${path}.item`), itemIdExpected, `${path}.item`);
}
function parseErrors(value: Record<string, unknown>, path: string): CollectionInvalid {
  keys(value, ["status", "errors"], path);
  const errors = array(value.errors, `${path}.errors`, 100).map((inputError, index) => {
    const error = record(inputError, `${path}.errors[${index}]`);
    keys(error, ["field", "message"], `${path}.errors[${index}]`);
    return { field: lineText(error.field, `${path}.errors[${index}].field`, 80), message: label(error.message, `${path}.errors[${index}].message`, 400) };
  });
  return { status: "invalid", errors };
}

export function parseCollectionListResult(input: unknown, collectionId: string): CollectionListResult {
  const value = record(input, "list");
  if (value.status === "forbidden") { keys(value, ["status"], "list"); return { status: "forbidden" }; }
  keys(value, ["status", "collectionId", "items"], "list");
  if (value.status !== "ready") fail("list.status", "invalid status");
  if (key(value.collectionId, "list.collectionId") !== collectionId) fail("list.collectionId", "collection identity mismatch");
  const items = array(value.items, "list.items", 10_000).map((item, index) => parseCollectionItemSummary(item, `list.items[${index}]`));
  if (new Set(items.map((item) => item.id)).size !== items.length) fail("list.items", "duplicate item");
  return { status: "ready", collectionId, items };
}

export function parseCollectionItemResult(input: unknown, definition: CollectionDefinition, expectedItemId?: string): CollectionItemResult {
  const value = record(input, "load");
  const shared = common(value, "load");
  if (shared) return shared;
  if (value.status !== "ready") fail("load.status", "invalid status");
  return { status: "ready", item: withItem(value, definition, expectedItemId, "load") };
}

/** createItem・duplicate の応答。 */
export function parseCollectionCreateResult(input: unknown, definition: CollectionDefinition): CollectionCreateResult {
  const value = record(input, "create");
  const shared = common(value, "create");
  if (shared) return shared;
  if (value.status !== "created") fail("create.status", "invalid status");
  return { status: "created", item: withItem(value, definition, undefined, "create") };
}

/** saveDraft・discardDraft・unpublish・schedule・cancelSchedule の応答。 */
export function parseCollectionSaveResult(input: unknown, definition: CollectionDefinition, expectedItemId?: string): CollectionSaveResult {
  const value = record(input, "save");
  const shared = common(value, "save");
  if (shared) return shared;
  if (value.status === "invalid") return parseErrors(value, "save");
  if (value.status !== "saved" && value.status !== "conflict") fail("save.status", "invalid status");
  return { status: value.status, item: withItem(value, definition, expectedItemId, "save") };
}

export function parseCollectionPublishResult(input: unknown, definition: CollectionDefinition, expectedItemId?: string): CollectionPublishResult {
  const value = record(input, "publish");
  const shared = common(value, "publish");
  if (shared) return shared;
  if (value.status === "invalid") return parseErrors(value, "publish");
  if (value.status !== "published" && value.status !== "publishing" && value.status !== "conflict") fail("publish.status", "invalid status");
  return { status: value.status, item: withItem(value, definition, expectedItemId, "publish") };
}

export function parseCollectionRemoveResult(input: unknown, definition: CollectionDefinition, expectedItemId?: string): CollectionRemoveResult {
  const value = record(input, "remove");
  const shared = common(value, "remove");
  if (shared) return shared;
  if (value.status === "removed") { keys(value, ["status"], "remove"); return { status: "removed" }; }
  if (value.status !== "conflict") fail("remove.status", "invalid status");
  return { status: "conflict", item: withItem(value, definition, expectedItemId, "remove") };
}

export function parseCollectionUploadResult(input: unknown): CollectionUploadResult {
  const value = record(input, "upload");
  if (value.status === "rejected") {
    keys(value, ["status", "reason"], "upload");
    if (!["type", "size", "permission", "invalid"].includes(value.reason as string)) fail("upload.reason", "invalid reason");
    return { status: "rejected", reason: value.reason as CollectionUploadRejectReason };
  }
  keys(value, ["status", "url", "width", "height"], "upload");
  if (value.status !== "uploaded") fail("upload.status", "invalid status");
  const url = value.url;
  if (!isDisplayableImageUrl(url) || url.startsWith("http:")) fail("upload.url", "expected an https URL or a site path");
  const width = optional(value, "width", (size) => positiveInt(size, "upload.width", 100_000));
  const height = optional(value, "height", (size) => positiveInt(size, "upload.height", 100_000));
  return { status: "uploaded", url, ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }) };
}

/* ---------- 値の検証（公開・予約の前） ---------- */

function isEmpty(field: CollectionField, value: CollectionValue | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "string") return value.length === 0;
  if (field.type !== "richText") return !value.trim();
  // 本文はタグと空白（&nbsp; を含む）だけなら空。画像・区切り線は中身として数える。
  return !/<(?:img|hr)\b/iu.test(value) && !value.replace(/<[^>]*>/gu, "").replace(/&nbsp;|\u00a0/gu, "").trim();
}

/** 必須・長さ・slug・url・日時・選択肢を確かめる。戻り値は definition の並び順。 */
export function validateCollectionValues(definition: CollectionDefinition, values: CollectionValues): CollectionFieldError[] {
  const errors: CollectionFieldError[] = [];
  for (const field of definition.fields) {
    const value = values[field.key];
    const push = (message: string) => errors.push({ field: field.key, message });
    if (field.required && isEmpty(field, value)) { push(field.type === "image" ? "画像を選んでください。" : field.type === "select" || field.type === "reference" ? "選んでください。" : "入力してください。"); continue; }
    if (isEmpty(field, value)) continue;
    switch (field.type) {
      case "text": case "longText":
        if (field.maxLength !== undefined && typeof value === "string" && [...value].length > field.maxLength) push(`${field.maxLength} 文字以内にしてください（いま ${[...value].length} 文字）。`);
        break;
      case "slug":
        if (typeof value !== "string" || !COLLECTION_SLUG_PATTERN.test(value)) push("半角の英数字・ハイフン・アンダースコアだけで入力してください。");
        break;
      case "url":
        if (!isHttpUrl(value)) push("http:// か https:// から始まるアドレスを入力してください。");
        break;
      case "datetime":
        if (!isIsoTimestamp(value)) push("日時を正しく入力してください。");
        break;
      case "image":
        if (!isDisplayableImageUrl(value)) push("画像を選び直してください。");
        break;
      case "select":
        if (Array.isArray(value) && value.some((id) => !field.options.some((option) => option.id === id))) push("選べない値が入っています。選び直してください。");
        break;
      default:
        break;
    }
  }
  return errors;
}

/* ---------- 一覧の並び・絞り込み・日時の入力 ---------- */

export type CollectionFilter = "all" | "published" | "draft";
/** 「公開中」には published・changed・publishing を、「下書き」には draft・scheduled を数える。 */
export function collectionItemFilter(status: CollectionItemStatus): Exclude<CollectionFilter, "all"> {
  return status === "draft" || status === "scheduled" ? "draft" : "published";
}
const time = (value: string | null) => value === null ? -Infinity : Date.parse(value);
/**
 * ordering が publishedAt なら公開日時の新しい順（公開日時の無い下書きは先頭・その中は更新の新しい順）。
 * manual なら order の小さい順（order の無いものは先頭）。同じなら更新の新しい順・題名順。
 */
export function sortCollectionItems<T extends CollectionItemSummary>(items: readonly T[], ordering: CollectionOrdering): T[] {
  const tie = (a: T, b: T) => time(b.updatedAt) - time(a.updatedAt) || a.title.localeCompare(b.title, "ja") || a.id.localeCompare(b.id);
  return [...items].sort((a, b) => {
    if (ordering === "manual") {
      if (a.order === null || b.order === null) return a.order === b.order ? tie(a, b) : a.order === null ? -1 : 1;
      return a.order - b.order || tie(a, b);
    }
    if (a.publishedAt === null || b.publishedAt === null) return a.publishedAt === b.publishedAt ? tie(a, b) : a.publishedAt === null ? -1 : 1;
    return time(b.publishedAt) - time(a.publishedAt) || tie(a, b);
  });
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? NaN);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}
const pad = (value: number, size = 2) => String(value).padStart(size, "0");
/** ISO の日時を、timeZone の壁時計の datetime-local の値（YYYY-MM-DDTHH:mm）にする。 */
export function collectionDateInputValue(iso: string | null, timeZone: string): string {
  if (iso === null || !Number.isFinite(Date.parse(iso))) return "";
  const p = zonedParts(new Date(iso), timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}
/** datetime-local の値（timeZone の壁時計）を ISO（UTC・Z）にする。読めなければ null。 */
export function collectionDateFromInput(value: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s = "0"] = match;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (!Number.isFinite(wall)) return null;
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), timeZone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    if (!Number.isFinite(shown)) return null;
    if (shown === wall) break;
    guess += wall - shown;
  }
  const result = new Date(guess).toISOString();
  return isIsoTimestamp(result) ? result : null;
}

/* ---------- 本文（richText）の HTML の無害化 ---------- */

const KEEP = new Set(["p", "h2", "h3", "h4", "strong", "em", "ul", "ol", "li", "blockquote", "br", "hr", "a", "figure", "figcaption", "img"]);
const RENAME: Readonly<Record<string, string>> = { b: "strong", i: "em", h1: "h2", h5: "h4", h6: "h4" };
/** 中身ごと消す要素。 */
const DROP = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "noscript", "noembed", "noframes", "template",
  "svg", "math", "link", "meta", "base", "title", "head", "form", "input", "button", "select", "option", "optgroup", "textarea",
  "canvas", "audio", "video", "source", "track", "param", "picture", "map", "area", "dialog", "portal", "slot", "datalist", "output",
]);
const BLOCK = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "figure", "hr", "div", "section", "article", "table", "pre", "header", "footer", "aside", "nav", "main"]);

export type RichTextSanitizeOptions = {
  /** https 以外の画像を残すかどうか。"/" から始まる同じサイトの path にだけ使う。既定は https だけ。 */
  readonly isImageSrcAllowed?: (src: string) => boolean;
};

function linkHref(value: string | null): string | null {
  if (value === null) return null;
  const href = value.trim();
  if (!href || href.length > 2048 || /[\s\u0000-\u001f\u007f<>"'\\]/u.test(href)) return null;
  try {
    const url = new URL(href);
    if (url.protocol === "mailto:") return href;
    if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname && !url.username && !url.password) return href;
  } catch { /* 相対 URL・壊れた URL は外す */ }
  return null;
}
function imageSrc(value: string | null, options: RichTextSanitizeOptions): string | null {
  if (value === null) return null;
  const src = value.trim();
  if (!src || src.length > 2048 || /[\s\u0000-\u001f\u007f<>"'\\]/u.test(src)) return null;
  if (src.startsWith("/") && !src.startsWith("//")) return options.isImageSrcAllowed?.(src) === true ? src : null;
  try {
    const url = new URL(src);
    return url.protocol === "https:" && url.hostname && !url.username && !url.password ? src : null;
  } catch { return null; }
}
/** 本文のリンクに使ってよいか（http・https・mailto）。 */
export function isRichTextLinkAllowed(value: string): boolean { return linkHref(value) !== null; }
const sizeAttr = (value: string | null) => value !== null && /^\d{1,5}$/u.test(value.trim()) ? value.trim() : null;

/**
 * 本文の HTML から、残してよい要素・属性だけを残す。ブラウザ（または jsdom）の DOMParser を使う。
 * 残す要素: p, h2, h3, h4, strong, em, ul, ol, li, blockquote, br, hr, a, figure, figcaption, img（b→strong・i→em・h1→h2・h5/h6→h4・中に段落を持たない div→p）。
 * 残す属性: a の href（http・https・mailto）、img の src（https）・alt・width・height。それ以外は落とす。
 * script・style・iframe などは中身ごと消し、知らない要素は外して中身を残す。ホストも保存・公開の前に無害化すること。
 */
export function sanitizeRichTextHtml(html: string, options: RichTextSanitizeOptions = {}): string {
  const Parser = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
  if (!Parser) throw new Error("sanitizeRichTextHtml needs DOMParser");
  if (typeof html !== "string" || !html) return "";
  const doc = new Parser().parseFromString(`<!doctype html><html><head></head><body>${html}</body></html>`, "text/html");
  const out = doc.createElement("div");
  const clean = (node: Node, parent: Node): void => {
    if (node.nodeType === 3) { parent.appendChild(doc.createTextNode(node.textContent ?? "")); return; }
    if (node.nodeType !== 1) return;
    const element = node as Element, raw = element.localName.toLowerCase();
    if (element.namespaceURI !== "http://www.w3.org/1999/xhtml" || DROP.has(raw)) return;
    let tag = RENAME[raw] ?? raw;
    if (raw === "div" && !Array.from(element.children).some((child) => BLOCK.has(child.localName.toLowerCase()))) tag = "p";
    const unwrap = () => { for (const child of Array.from(element.childNodes)) clean(child, parent); };
    if (!KEEP.has(tag)) { unwrap(); return; }
    if (tag === "img") {
      const src = imageSrc(element.getAttribute("src"), options);
      if (src === null) return;
      const img = doc.createElement("img");
      img.setAttribute("src", src);
      img.setAttribute("alt", (element.getAttribute("alt") ?? "").slice(0, 500));
      for (const name of ["width", "height"]) { const size = sizeAttr(element.getAttribute(name)); if (size !== null) img.setAttribute(name, size); }
      parent.appendChild(img);
      return;
    }
    if (tag === "a") {
      const href = linkHref(element.getAttribute("href"));
      if (href === null) { unwrap(); return; }
      const link = doc.createElement("a");
      link.setAttribute("href", href);
      for (const child of Array.from(element.childNodes)) clean(child, link);
      parent.appendChild(link);
      return;
    }
    const next = doc.createElement(tag);
    if (tag !== "br" && tag !== "hr") for (const child of Array.from(element.childNodes)) clean(child, next);
    parent.appendChild(next);
  };
  for (const child of Array.from(doc.body.childNodes)) clean(child, out);
  return out.innerHTML;
}

export { DocumentValidationError as CollectionValidationError };
