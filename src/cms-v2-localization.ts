import {
  applyAutomaticTranslationResult, createLocalizationOverlay, editLocalizedValue, localizationStatus, parseLocalizationOverlay, parseLocalizationValue,
  type LocalizationCollection, type LocalizationDraftEntry, type LocalizationOverlay, type LocalizationStatus, type LocalizationValue
} from "./localization.js";
import type { CmsField, CmsItemRevision, CmsSchema } from "./cms-v2-schema.js";
import { cmsCollection, cmsId, parseCmsItemRevision, parseCmsSchema, parseCmsValues } from "./cms-v2-schema.js";
import type { LocalizationLocale, LocalizedRichText } from "./localization-types.js";
import { fail, identifier, keys, localeCode, record, string } from "./validation-utils.js";

/** Canonical CMS item identity used by Studio localization and niho-edit. */
export type CmsLocalizationItemIdentity = {
  readonly siteId: string;
  readonly collectionId: string;
  readonly itemId: string;
  readonly sourceLocale: string;
  readonly targetLocale: string;
};
/** Stable identity of one translated CMS field. */
export type CmsLocalizationIdentity = CmsLocalizationItemIdentity & { readonly fieldId: string };
export type CmsLocalizationFieldKind = "text" | "rich-text";
export type CmsLocalizationField = {
  readonly identity: CmsLocalizationIdentity;
  /** `fieldId`-based unit IDs keep the generic workspace and CLI on the same operation key. */
  readonly unitId: string;
  readonly label: string;
  readonly kind: CmsLocalizationFieldKind;
  readonly sourceValue: string | LocalizedRichText;
  /** Sanitized source HTML is retained for stale checks and attribute-preserving serialization. */
  readonly sourceHtml?: string;
  readonly sourceFingerprint: string;
  readonly maxLength?: number;
};
export type CmsLocalizationIssue = { readonly fieldId: string; readonly code: "RICH_TEXT_ADAPTER_REQUIRED" };
export type CmsLocalizationRichTextAdapter = {
  /** Parse CMS HTML into a tree and return its host-sanitized HTML for safe attribute preservation. */
  readonly parse: (html: string, field: CmsField) => { readonly value: LocalizedRichText; readonly sourceHtml: string };
  /** Serialize through the host sanitizer, using sanitized source HTML to retain checked attributes such as href. */
  readonly serialize: (value: LocalizedRichText, field: CmsField, sourceHtml: string) => string;
};
export type CmsLocalizationCollection = {
  readonly identity: CmsLocalizationItemIdentity;
  readonly schema: CmsSchema;
  readonly sourceItem: CmsItemRevision;
  readonly sourceRevision: string;
  readonly scopeId: string;
  readonly fields: readonly CmsLocalizationField[];
  readonly issues: readonly CmsLocalizationIssue[];
  readonly localization: LocalizationCollection;
};
export type CmsLocalizationOverlay = {
  readonly schemaVersion: 1;
  readonly identity: CmsLocalizationItemIdentity;
  readonly version: number;
  readonly entries: readonly LocalizationDraftEntry[];
};
export type CmsLocalizationResult = {
  readonly schemaVersion: 1;
  readonly resultId: string;
  readonly identity: CmsLocalizationItemIdentity;
  readonly baseVersion: number;
  readonly values: readonly { readonly fieldId: string; readonly sourceFingerprint: string; readonly value: string | LocalizedRichText }[];
};
export type CmsLocalizedItemPlan =
  | { readonly status: "ready"; readonly item: CmsItemRevision; readonly missingFieldIds: readonly string[] }
  | { readonly status: "omitted"; readonly missingFieldIds: readonly string[] };

const LOCALE_FAMILY: Readonly<Record<string, LocalizationLocale>> = { ja: "ja", en: "en" };
const TRANSLATABLE_TEXT_TYPES = new Set<CmsField["type"]>(["text", "longText", "url", "slug"]);
const CMS_UNIT_PREFIX = "cms.field.";
const INTERNAL_LOCALIZATION_SITE_ID = "cms-localization";
const MAX_SOURCE_TEXT = 100_000;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

function localizationFamily(value: unknown, path: string): { locale: string; family: LocalizationLocale } {
  const locale = localeCode(value, path);
  const language = locale.split("-", 1)[0]!.toLowerCase();
  const family = LOCALE_FAMILY[language];
  if (!family) fail(path, "CMS localization currently supports Japanese and English locales");
  return { locale, family };
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  fail("$cmsLocalization", "value is not canonical JSON");
}

async function hash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/u.test(value) || RESERVED.has(value)) fail("itemKey", "invalid CMS localization key");
  let bytes: Uint8Array;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch { return fail("itemKey", "invalid CMS localization key"); }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return fail("itemKey", "invalid CMS localization key"); }
}

/** Stable workspace key. It contains collection/item identity only; site and locale remain explicit in the CMS identity. */
export function cmsLocalizationItemKey(collectionIdInput: unknown, itemIdInput: unknown): string {
  const collectionId = cmsId(collectionIdInput, "collectionId"), itemId = cmsId(itemIdInput, "itemId");
  const key = base64UrlEncode(`cms:${collectionId}:${itemId}`);
  if (key.length > 200) fail("itemKey", "CMS localization key is too long");
  return key;
}

/** Parse the stable workspace key without trusting its encoded contents. */
export function parseCmsLocalizationItemKey(input: unknown): { readonly collectionId: string; readonly itemId: string } {
  const key = string(input, "itemKey", 200), decoded = base64UrlDecode(key);
  const match = /^cms:([^:]+):([^:]+)$/u.exec(decoded);
  if (!match || cmsLocalizationItemKey(match[1], match[2]) !== key) fail("itemKey", "invalid CMS localization key");
  return { collectionId: cmsId(match[1], "itemKey.collectionId"), itemId: cmsId(match[2], "itemKey.itemId") };
}

export function parseCmsLocalizationIdentity(input: unknown): CmsLocalizationIdentity {
  const value = record(input, "$cmsIdentity");
  keys(value, ["siteId", "collectionId", "itemId", "fieldId", "sourceLocale", "targetLocale"], "$cmsIdentity");
  const source = localizationFamily(value.sourceLocale, "$cmsIdentity.sourceLocale");
  const target = localizationFamily(value.targetLocale, "$cmsIdentity.targetLocale");
  if (source.locale === target.locale || source.family === target.family) fail("$cmsIdentity.targetLocale", "source and target locales must differ");
  return { siteId: cmsId(value.siteId, "$cmsIdentity.siteId"), collectionId: cmsId(value.collectionId, "$cmsIdentity.collectionId"),
    itemId: cmsId(value.itemId, "$cmsIdentity.itemId"), fieldId: cmsId(value.fieldId, "$cmsIdentity.fieldId"),
    sourceLocale: source.locale, targetLocale: target.locale };
}

function parseItemIdentity(input: unknown): CmsLocalizationItemIdentity {
  const value = record(input, "$cmsIdentity");
  keys(value, ["siteId", "collectionId", "itemId", "sourceLocale", "targetLocale"], "$cmsIdentity");
  const source = localizationFamily(value.sourceLocale, "$cmsIdentity.sourceLocale");
  const target = localizationFamily(value.targetLocale, "$cmsIdentity.targetLocale");
  if (source.locale === target.locale || source.family === target.family) fail("$cmsIdentity.targetLocale", "source and target locales must differ");
  return { siteId: cmsId(value.siteId, "$cmsIdentity.siteId"), collectionId: cmsId(value.collectionId, "$cmsIdentity.collectionId"),
    itemId: cmsId(value.itemId, "$cmsIdentity.itemId"), sourceLocale: source.locale, targetLocale: target.locale };
}

function sameItemIdentity(left: CmsLocalizationItemIdentity, right: CmsLocalizationItemIdentity): boolean {
  return left.siteId === right.siteId && left.collectionId === right.collectionId && left.itemId === right.itemId
    && left.sourceLocale === right.sourceLocale && left.targetLocale === right.targetLocale;
}

function genericLocale(value: string): LocalizationLocale {
  return localizationFamily(value, "$cmsIdentity.locale").family;
}

function unitId(fieldId: string): string {
  const id = `${CMS_UNIT_PREFIX}${fieldId}`;
  if (id.length > 300) fail("fieldId", "CMS field ID is too long");
  return id;
}

async function scopeId(identity: CmsLocalizationItemIdentity): Promise<string> {
  const digest = await hash({ schemaVersion: 1, ...identity });
  return `cms_${digest.slice("sha256:".length, 48)}`;
}

function localizationCollection(collection: Pick<CmsLocalizationCollection, "identity" | "scopeId" | "fields" | "issues">): LocalizationCollection {
  return { siteId: INTERNAL_LOCALIZATION_SITE_ID, pageId: collection.scopeId, sourceLocale: genericLocale(collection.identity.sourceLocale),
    targetLocale: genericLocale(collection.identity.targetLocale),
    units: collection.fields.map((field) => ({ unitId: field.unitId, scope: "page", ownerId: collection.identity.itemId,
      field: `cms.field.${field.identity.fieldId}`, kind: field.kind, translatable: true, required: true, sourceValue: field.sourceValue,
      sourceFingerprint: field.sourceFingerprint, context: `CMS field ${field.identity.fieldId}`,
      ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }) })),
    issues: collection.issues.map(({ fieldId }) => ({ code: "UNSUPPORTED_RICH_TEXT", scope: "page", ownerId: collection.identity.itemId,
      message: `CMS field ${fieldId} requires the host rich-text adapter.` })) };
}

/** Extract localizable CMS fields. Rich text requires the host's safe parser; all other CMS values remain unchanged. */
export async function collectCmsLocalizationUnits(schemaInput: unknown, itemInput: unknown, targetLocaleInput: unknown,
  options: { readonly richText?: CmsLocalizationRichTextAdapter } = {}): Promise<CmsLocalizationCollection> {
  const schema = parseCmsSchema(schemaInput), item = parseCmsItemRevision(itemInput, schema);
  const source = localizationFamily(item.locale, "$item.locale"), target = localizationFamily(targetLocaleInput, "$targetLocale");
  if (source.locale === target.locale || source.family === target.family) fail("$targetLocale", "target locale must differ from source locale");
  if (item.locale !== source.locale) fail("$item.locale", "source locale does not match CMS item");
  const identity: CmsLocalizationItemIdentity = { siteId: item.siteId, collectionId: item.collectionId, itemId: item.itemId,
    sourceLocale: source.locale, targetLocale: target.locale };
  const collection = cmsCollection(schema, item.collectionId), fields: CmsLocalizationField[] = [], issues: CmsLocalizationIssue[] = [];
  for (const field of collection.fields) {
    const raw = item.values[field.fieldId];
    if (TRANSLATABLE_TEXT_TYPES.has(field.type)) {
      if (typeof raw !== "string" || raw === "") continue;
      const sourceValue = string(raw, `item.values.${field.fieldId}`, MAX_SOURCE_TEXT);
      const identityWithField = { ...identity, fieldId: field.fieldId };
      fields.push({ identity: identityWithField, unitId: unitId(field.fieldId), label: field.label, kind: "text", sourceValue,
        sourceFingerprint: await hash({ identity: identityWithField, schemaRevision: schema.schemaRevision, sourceValue }),
        ...(typeof (field as { maxLength?: unknown }).maxLength === "number" ? { maxLength: Math.min((field as { maxLength: number }).maxLength, MAX_SOURCE_TEXT) } : {}) });
      continue;
    }
    if (field.type !== "richText" || typeof raw !== "string" || raw === "") continue;
    if (!options.richText) { issues.push({ fieldId: field.fieldId, code: "RICH_TEXT_ADAPTER_REQUIRED" }); continue; }
    const parsed = record(options.richText.parse(raw, field), `item.values.${field.fieldId}`);
    keys(parsed, ["value", "sourceHtml"], `item.values.${field.fieldId}`);
    const sourceValue = parseLocalizationValue(parsed.value, "rich-text", `item.values.${field.fieldId}`) as LocalizedRichText;
    const sourceHtml = string(parsed.sourceHtml, `item.values.${field.fieldId}.sourceHtml`, 2_000_000);
    const identityWithField = { ...identity, fieldId: field.fieldId };
    fields.push({ identity: identityWithField, unitId: unitId(field.fieldId), label: field.label, kind: "rich-text", sourceValue, sourceHtml,
      sourceFingerprint: await hash({ identity: identityWithField, schemaRevision: schema.schemaRevision, sourceValue, sourceHtml: raw, sanitizedSourceHtml: sourceHtml }) });
  }
  const result = { identity, schema, sourceItem: item, sourceRevision: item.revision, scopeId: await scopeId(identity), fields, issues };
  return { ...result, localization: localizationCollection(result) };
}

function validateCollection(collection: CmsLocalizationCollection): LocalizationCollection {
  const identity = parseItemIdentity(collection.identity);
  const item = parseCmsItemRevision(collection.sourceItem, collection.schema);
  if (!sameItemIdentity(identity, collection.identity) || item.siteId !== identity.siteId || item.collectionId !== identity.collectionId
    || item.itemId !== identity.itemId || item.locale !== identity.sourceLocale
    || item.revision !== collection.sourceRevision) fail("$cmsCollection", "CMS localization source identity or revision mismatch");
  if (collection.scopeId.length < 16 || !collection.scopeId.startsWith("cms_")) fail("$cmsCollection.scopeId", "invalid CMS localization scope");
  return localizationCollection(collection);
}

function genericOverlay(input: unknown, collection: CmsLocalizationCollection): LocalizationOverlay {
  const source = record(input, "$cmsOverlay");
  keys(source, ["schemaVersion", "identity", "version", "entries"], "$cmsOverlay");
  if (source.schemaVersion !== 1) fail("$cmsOverlay.schemaVersion", "unsupported CMS localization version");
  const identity = parseItemIdentity(source.identity);
  if (!sameItemIdentity(identity, collection.identity)) fail("$cmsOverlay.identity", "CMS localization identity mismatch");
  const overlay = parseLocalizationOverlay({ schemaVersion: 1, siteId: INTERNAL_LOCALIZATION_SITE_ID, pageId: collection.scopeId,
    sourceLocale: genericLocale(identity.sourceLocale), targetLocale: genericLocale(identity.targetLocale), version: source.version, entries: source.entries });
  const unitIds = new Set(collection.fields.map(({ unitId: id }) => id));
  if (overlay.entries.some((entry) => !unitIds.has(entry.unitId))) fail("$cmsOverlay.entries", "unknown CMS field ID");
  return overlay;
}

function cmsOverlay(overlay: LocalizationOverlay, identity: CmsLocalizationItemIdentity): CmsLocalizationOverlay {
  return { schemaVersion: 1, identity, version: overlay.version, entries: overlay.entries };
}

export function createCmsLocalizationOverlay(collection: CmsLocalizationCollection): CmsLocalizationOverlay {
  const localization = validateCollection(collection);
  return cmsOverlay(createLocalizationOverlay(localization), collection.identity);
}

export function parseCmsLocalizationOverlay(input: unknown, collection: CmsLocalizationCollection): CmsLocalizationOverlay {
  const overlay = genericOverlay(input, collection);
  return cmsOverlay(overlay, collection.identity);
}

export function editCmsLocalizedValue(input: unknown, collection: CmsLocalizationCollection,
  edit: { readonly fieldId: string; readonly expectedVersion: number; readonly value: LocalizationValue }): CmsLocalizationOverlay {
  const localization = validateCollection(collection), overlay = genericOverlay(input, collection), fieldId = cmsId(edit.fieldId, "$edit.fieldId");
  const unit = collection.fields.find((entry) => entry.identity.fieldId === fieldId);
  if (!unit) fail("$edit.fieldId", "unknown or non-localizable CMS field");
  const next = editLocalizedValue(overlay, localization, { unitId: unit.unitId, expectedVersion: edit.expectedVersion, value: edit.value });
  return cmsOverlay(next, collection.identity);
}

export function applyAutomaticCmsTranslationResult(input: unknown, collection: CmsLocalizationCollection, resultInput: unknown): CmsLocalizationOverlay {
  const localization = validateCollection(collection), overlay = genericOverlay(input, collection), source = record(resultInput, "$cmsResult");
  keys(source, ["schemaVersion", "resultId", "identity", "baseVersion", "values"], "$cmsResult");
  if (source.schemaVersion !== 1) fail("$cmsResult.schemaVersion", "unsupported CMS localization result version");
  const identity = parseItemIdentity(source.identity);
  if (!sameItemIdentity(identity, collection.identity)) fail("$cmsResult.identity", "CMS localization result identity mismatch");
  if (!Array.isArray(source.values) || source.values.length < 1 || source.values.length > collection.fields.length) fail("$cmsResult.values", "invalid CMS translation values");
  const values = source.values.map((raw, index) => {
    const path = `$cmsResult.values[${index}]`, value = record(raw, path);
    keys(value, ["fieldId", "sourceFingerprint", "value"], path);
    const fieldId = cmsId(value.fieldId, `${path}.fieldId`), field = collection.fields.find((entry) => entry.identity.fieldId === fieldId);
    if (!field) fail(`${path}.fieldId`, "unknown or non-localizable CMS field");
    if (field.kind === "text" && typeof value.value !== "string") fail(`${path}.value`, "expected translated text");
    return { unitId: field.unitId, sourceFingerprint: string(value.sourceFingerprint, `${path}.sourceFingerprint`, 80), value: value.value as string | LocalizedRichText };
  });
  if (new Set(values.map(({ unitId: id }) => id)).size !== values.length) fail("$cmsResult.values", "duplicate CMS field ID");
  const next = applyAutomaticTranslationResult(overlay, localization, { schemaVersion: 1, resultId: identifier(source.resultId, "$cmsResult.resultId"),
    siteId: INTERNAL_LOCALIZATION_SITE_ID, pageId: collection.scopeId, sourceLocale: genericLocale(identity.sourceLocale), targetLocale: genericLocale(identity.targetLocale),
    baseVersion: source.baseVersion, values });
  return cmsOverlay(next, collection.identity);
}

export function cmsLocalizationStatus(input: unknown, collection: CmsLocalizationCollection): LocalizationStatus {
  const overlay = genericOverlay(input, collection);
  const status = localizationStatus(overlay, validateCollection(collection));
  if (!collection.issues.length) return status;
  return { ...status, complete: false, units: status.units + collection.issues.length, missing: status.missing + collection.issues.length,
    details: [...status.details, ...collection.issues.map(({ fieldId }) => ({ unitId: unitId(fieldId), state: "missing" as const, hasCandidate: false }))] };
}

/** Materialize one immutable target-locale CMS revision. `source` is explicit fallback; `omit` excludes incomplete items. */
export function materializeCmsLocalizedItem(input: unknown, collection: CmsLocalizationCollection, options: {
  readonly revision: string;
  readonly fallback: "source" | "omit";
  readonly richText?: CmsLocalizationRichTextAdapter;
}): CmsLocalizedItemPlan {
  const settings = record(options, "$options");
  keys(settings, ["revision", "fallback", "richText"], "$options");
  if (settings.fallback !== "source" && settings.fallback !== "omit") fail("$options.fallback", "expected source or omit");
  const revision = cmsId(settings.revision, "$revision");
  let richText: CmsLocalizationRichTextAdapter | undefined;
  if (settings.richText !== undefined) {
    const adapter = record(settings.richText, "$options.richText");
    keys(adapter, ["parse", "serialize"], "$options.richText");
    if (typeof adapter.parse !== "function" || typeof adapter.serialize !== "function") fail("$options.richText", "invalid CMS rich-text adapter");
    richText = adapter as unknown as CmsLocalizationRichTextAdapter;
  }
  validateCollection(collection);
  const overlay = genericOverlay(input, collection);
  const entries = new Map(overlay.entries.map((entry) => [entry.unitId, entry]));
  const missing = collection.fields.filter((field) => {
    const entry = entries.get(field.unitId);
    return !entry?.draftValue || entry.draftSourceFingerprint !== field.sourceFingerprint;
  }).map(({ identity }) => identity.fieldId);
  for (const issue of collection.issues) if (!missing.includes(issue.fieldId)) missing.push(issue.fieldId);
  if (settings.fallback === "omit" && (collection.fields.length === 0 || missing.length > 0)) return { status: "omitted", missingFieldIds: missing };
  const values: Record<string, unknown> = { ...collection.sourceItem.values };
  for (const field of collection.fields) {
    const entry = entries.get(field.unitId);
    if (!entry?.draftValue || entry.draftSourceFingerprint !== field.sourceFingerprint) continue;
    if (field.kind === "text") values[field.identity.fieldId] = string(entry.draftValue, `$values.${field.identity.fieldId}`, MAX_SOURCE_TEXT);
    else {
      if (!richText) fail("$richText", "CMS rich text serializer is required");
      if (field.sourceHtml === undefined) fail("$richText", "CMS rich text source is required");
      const serialized = richText.serialize(entry.draftValue as LocalizedRichText,
        cmsCollection(collection.schema, collection.identity.collectionId).fields.find(({ fieldId }) => fieldId === field.identity.fieldId)!, field.sourceHtml);
      values[field.identity.fieldId] = string(serialized, `$values.${field.identity.fieldId}`, 2_000_000);
    }
  }
  const definition = cmsCollection(collection.schema, collection.identity.collectionId);
  const checkedValues = parseCmsValues(values, definition);
  const item = parseCmsItemRevision({ ...collection.sourceItem, locale: collection.identity.targetLocale, revision, values: checkedValues }, collection.schema);
  return { status: "ready", item, missingFieldIds: missing };
}
