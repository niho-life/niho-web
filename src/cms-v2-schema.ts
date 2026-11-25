import {
  parseCollectionSchemaResult, parseCollectionValues, validateCollectionValues,
  type CollectionDefinition, type CollectionField, type CollectionValue, type CollectionValues
} from "./collection-model.js";
import { validatePagePath } from "./pages.js";
import { DocumentValidationError, fail, keys, localeCode, record, string } from "./validation-utils.js";

export type CmsField = CollectionField & { readonly fieldId: string };
/** Field references use fieldId. key is the name exposed to clients that address fields by name. */
export type CmsCollection = Omit<CollectionDefinition, "fields"> & { readonly fields: readonly CmsField[] };
export type CmsSchema = {
  readonly contractVersion: 2;
  readonly siteId: string;
  readonly schemaRevision: string;
  readonly collections: readonly CmsCollection[];
  /** Retained after removal, including fields of deleted collections. */
  readonly retiredFields: readonly { readonly collectionId: string; readonly fieldId: string }[];
};
export type CmsItemKey = { readonly collectionId: string; readonly itemId: string };
export type CmsItemRevision = CmsItemKey & {
  readonly siteId: string;
  readonly schemaRevision: string;
  readonly locale: string;
  readonly revision: string;
  readonly values: CollectionValues;
};
export type CmsProblem = {
  readonly code: "conversion" | "binding" | "route" | "reference" | "value";
  readonly message: string;
  readonly collectionId?: string;
  readonly itemId?: string;
  readonly fieldId?: string;
  readonly path?: string;
  readonly locale?: string;
};

export const cmsItemKey = ({ collectionId, itemId }: CmsItemKey): string => `${collectionId}/${itemId}`;
export function cmsId(value: unknown, path: string): string {
  const id = string(value, path, 128);
  if (!/^[A-Za-z0-9_][A-Za-z0-9._~-]*$/u.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) fail(path, "invalid CMS identifier");
  return id;
}
export function cmsArray(input: unknown, path: string, limit: number): unknown[] {
  if (!Array.isArray(input) || input.length > limit) fail(path, "invalid CMS array size");
  return input;
}
export function uniqueCmsKeys(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) fail(path, "duplicate CMS identifier");
}
export function cmsPath(input: unknown, path: string): string {
  if (typeof input !== "string" || validatePagePath(input) !== null) fail(path, "invalid CMS path");
  return input;
}

function mapCollectionFields(definition: CollectionDefinition, names: ReadonlyMap<string, string>): CollectionDefinition {
  const mapped = (key: string | null) => key === null ? null : names.get(key) ?? key;
  return {
    ...definition, titleField: mapped(definition.titleField)!, slugField: mapped(definition.slugField),
    imageField: mapped(definition.imageField), subtitleField: mapped(definition.subtitleField),
    fields: definition.fields.map((field) => ({ ...field, key: mapped(field.key)! }))
  };
}
function legacyDefinition(collection: CmsCollection): CollectionDefinition {
  const fields = collection.fields.map(({ fieldId, ...field }) => ({ ...field, key: fieldId }));
  return mapCollectionFields({ ...collection, fields }, new Map(collection.fields.map(({ fieldId, key }) => [fieldId, key])));
}
function fieldIdDefinition(collection: CmsCollection): CollectionDefinition {
  return { ...collection, fields: collection.fields.map(({ fieldId, ...field }) => ({ ...field, key: fieldId })) };
}
export function parseCmsSchema(input: unknown): CmsSchema {
  const raw = record(input, "schema");
  keys(raw, ["contractVersion", "siteId", "schemaRevision", "collections", "retiredFields"], "schema");
  if (raw.contractVersion !== 2) fail("schema.contractVersion", "unsupported CMS contract version");
  const siteId = cmsId(raw.siteId, "schema.siteId"), schemaRevision = cmsId(raw.schemaRevision, "schema.schemaRevision");
  const fieldIds: string[][] = [], fieldNames: string[][] = [];
  const definitions = cmsArray(raw.collections, "schema.collections", 50).map((input, index) => {
    const at = `schema.collections[${index}]`, collection = record(input, at);
    const ids: string[] = [], names: string[] = [];
    const fields = cmsArray(collection.fields, `${at}.fields`, 100).map((entry, fieldIndex) => {
      const fieldAt = `${at}.fields[${fieldIndex}]`;
      const { fieldId, ...field } = record(entry, fieldAt);
      ids.push(cmsId(fieldId, `${fieldAt}.fieldId`));
      names.push(cmsId(field.key, `${fieldAt}.key`));
      return field;
    });
    uniqueCmsKeys(ids, `${at}.fields`);
    fieldIds.push(ids);
    fieldNames.push(names);
    const namesById = new Map(ids.map((id, i) => [id, names[i]!]));
    const refs = {} as Record<string, unknown>;
    for (const key of ["titleField", "slugField", "imageField", "subtitleField"]) {
      const id = collection[key];
      refs[key] = id === null ? null : namesById.get(cmsId(id, `${at}.${key}`)) ?? fail(`${at}.${key}`, "unknown field ID");
    }
    if (collection.pathPrefix !== null) {
      const prefix = collection.pathPrefix;
      if (typeof prefix !== "string" || !prefix.endsWith("/") || refs.slugField === null) fail(`${at}.pathPrefix`, "path needs a trailing slash and slug field");
      cmsPath(prefix === "/" ? prefix : prefix.slice(0, -1), `${at}.pathPrefix`);
    }
    return { ...collection, ...refs, fields };
  });
  const checked = parseCollectionSchemaResult({ status: "ready", collections: definitions });
  if (checked.status !== "ready") fail("schema", "invalid collection definitions");
  const collections = checked.collections.map((collection, index): CmsCollection => {
    const ids = fieldIds[index]!, names = fieldNames[index]!;
    const mapped = mapCollectionFields(collection, new Map(names.map((name, i) => [name, ids[i]!])));
    return { ...mapped, fields: collection.fields.map((field, i) => ({ ...field, fieldId: ids[i]! })) };
  });
  const retiredFields = cmsArray(raw.retiredFields, "schema.retiredFields", 50_000).map((entry, index) => {
    const at = `schema.retiredFields[${index}]`, value = record(entry, at);
    keys(value, ["collectionId", "fieldId"], at);
    return { collectionId: cmsId(value.collectionId, `${at}.collectionId`), fieldId: cmsId(value.fieldId, `${at}.fieldId`) };
  });
  uniqueCmsKeys(retiredFields.map(({ collectionId, fieldId }) => `${collectionId}/${fieldId}`), "schema.retiredFields");
  const active = new Map(collections.map(({ id, fields }) => [id, new Set(fields.map(({ fieldId }) => fieldId))]));
  if (retiredFields.some(({ collectionId, fieldId }) => active.get(collectionId)?.has(fieldId))) fail("schema.retiredFields", "retired field ID was reused");
  return { contractVersion: 2, siteId, schemaRevision, collections, retiredFields };
}
export function cmsCollection(schema: CmsSchema, collectionId: string): CmsCollection {
  return schema.collections.find(({ id }) => id === collectionId) ?? fail("collectionId", "unknown CMS collection");
}
export function cmsLegacyCollections(schema: CmsSchema): readonly CollectionDefinition[] {
  return schema.collections.map(legacyDefinition);
}
export function cmsLegacyValues(collection: CmsCollection, values: CollectionValues): CollectionValues {
  return Object.fromEntries(collection.fields.map(({ fieldId, key }) => [key, values[fieldId]!]));
}
export function parseCmsValues(input: unknown, collection: CmsCollection, path = "values"): CollectionValues {
  const value = record(input, path);
  keys(value, collection.fields.map(({ fieldId }) => fieldId), path);
  return parseCollectionValues(value, fieldIdDefinition(collection), path);
}
export function cmsValueProblems(collection: CmsCollection, values: CollectionValues): CmsProblem[] {
  return validateCollectionValues(fieldIdDefinition(collection), values).map(({ field, message }) => ({
    code: "value", collectionId: collection.id, fieldId: field, message
  }));
}
export function parseCmsItemRevision(input: unknown, schema: CmsSchema): CmsItemRevision {
  const value = record(input, "itemRevision");
  keys(value, ["siteId", "schemaRevision", "collectionId", "itemId", "locale", "revision", "values"], "itemRevision");
  if (value.siteId !== schema.siteId || value.schemaRevision !== schema.schemaRevision) fail("itemRevision", "CMS site or schema revision mismatch");
  const collection = cmsCollection(schema, cmsId(value.collectionId, "itemRevision.collectionId"));
  return { siteId: schema.siteId, schemaRevision: schema.schemaRevision, collectionId: collection.id,
    itemId: cmsId(value.itemId, "itemRevision.itemId"), locale: localeCode(value.locale, "itemRevision.locale"), revision: cmsId(value.revision, "itemRevision.revision"),
    values: parseCmsValues(value.values, collection, "itemRevision.values") };
}

export type CmsMigrationChange = { readonly collectionId: string; readonly fieldId: string; readonly kind: "add" | "rename" | "convert" | "remove" };
export type CmsMigrationImpact = (before: CmsSchema, after: CmsSchema, changes: readonly CmsMigrationChange[], items: readonly CmsMigratedItem[]) => readonly CmsProblem[];
export type CmsMigrationDraft = { readonly item: unknown; readonly tombstoned: boolean };
export type CmsMigratedItem = CmsItemKey & { readonly locale: string; readonly tombstoned: boolean; readonly previousRevision: string; readonly values: CollectionValues };
export type CmsRemovedItem = CmsItemKey & { readonly locale: string; readonly tombstoned: boolean; readonly previousRevision: string };
export type CmsMigrationReplacement = CmsItemKey & { readonly locale: string; readonly values: CollectionValues };
const localizedKey = (item: CmsItemKey & { readonly locale: string }) => `${item.locale}/${cmsItemKey(item)}`;
export type CmsMigration = {
  readonly fromRevision: string;
  readonly schema: CmsSchema;
  readonly items: readonly CmsMigratedItem[];
  /** Items from removed collections remain in the plan so apply can CAS-check their source revisions. */
  readonly removedItems: readonly CmsRemovedItem[];
  readonly changes: readonly CmsMigrationChange[];
  readonly problems: readonly CmsProblem[];
};
const textualTypes = new Set(["text", "longText", "slug", "url"]);
function convertValue(value: CollectionValue, before: CmsField, after: CmsField): CollectionValue | undefined {
  if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) return undefined;
  const comparable = before.type === after.type && (before.type !== "reference" || after.type !== "reference" || before.collectionId === after.collectionId);
  if (comparable || (textualTypes.has(before.type) && textualTypes.has(after.type))) return value;
  throw new DocumentValidationError("values", "explicit replacement required for CMS field type change");
}

/** Host loads all drafts for the site. The plan keeps original revisions for compare-and-swap. */
export function planCmsMigration(beforeInput: unknown, nextInput: unknown, itemInputs: readonly CmsMigrationDraft[],
  replacements: readonly CmsMigrationReplacement[] = [], impact?: CmsMigrationImpact): CmsMigration {
  const before = parseCmsSchema(beforeInput), candidate = parseCmsSchema(nextInput);
  if (before.siteId !== candidate.siteId || before.schemaRevision === candidate.schemaRevision) fail("schema", "invalid migration target");
  const retired = new Map(before.retiredFields.map((entry) => [`${entry.collectionId}/${entry.fieldId}`, entry]));
  const changes: CmsMigrationChange[] = [];
  const fieldConfig = ({ fieldId: _id, key: _key, label: _label, hint: _hint, placement: _placement, ...field }: CmsField) => JSON.stringify(field);
  for (const collection of before.collections) {
    const next = candidate.collections.find(({ id }) => id === collection.id);
    for (const field of collection.fields) {
      const matching = next?.fields.find(({ fieldId }) => fieldId === field.fieldId);
      const key = { collectionId: collection.id, fieldId: field.fieldId };
      if (!matching) {
        retired.set(`${key.collectionId}/${key.fieldId}`, key);
        changes.push({ ...key, kind: "remove" });
        continue;
      }
      if (field.key !== matching.key || field.label !== matching.label) changes.push({ ...key, kind: "rename" });
      if (fieldConfig(field) !== fieldConfig(matching)) changes.push({ ...key, kind: "convert" });
    }
  }
  for (const collection of candidate.collections) {
    const previous = before.collections.find(({ id }) => id === collection.id);
    for (const field of collection.fields) {
      if (!previous?.fields.some(({ fieldId }) => fieldId === field.fieldId)) changes.push({ collectionId: collection.id, fieldId: field.fieldId, kind: "add" });
    }
  }
  // Hosts supply the proposed definition. The core owns the retired ID ledger.
  const schema = parseCmsSchema({ ...candidate, retiredFields: [...retired.values()] });
  const replacementByItem = new Map(replacements.map((entry) => [localizedKey(entry), entry.values]));
  if (replacementByItem.size !== replacements.length) fail("replacements", "duplicate replacement item");
  const items: CmsMigratedItem[] = [], removedItems: CmsRemovedItem[] = [], problems: CmsProblem[] = [];
  const drafts = itemInputs.map(({ item, tombstoned }) => ({ ...parseCmsItemRevision(item, before), tombstoned }));
  uniqueCmsKeys(drafts.map(localizedKey), "items");
  drafts.sort((left, right) => localizedKey(left) < localizedKey(right) ? -1 : 1);
  for (const item of drafts) {
    const target = { collectionId: item.collectionId, itemId: item.itemId, locale: item.locale };
    const previous = cmsCollection(before, item.collectionId);
    const next = schema.collections.find(({ id }) => id === item.collectionId);
    if (!next) {
      removedItems.push({ collectionId: item.collectionId, itemId: item.itemId, locale: item.locale,
        tombstoned: item.tombstoned, previousRevision: item.revision });
      continue;
    }
    const key = localizedKey(item);
    const replacement = record(replacementByItem.get(key) ?? {}, "replacement.values");
    keys(replacement, next.fields.map(({ fieldId }) => fieldId), "replacement.values");
    replacementByItem.delete(key);
    const values: Record<string, CollectionValue> = {};
    const failingFields = new Set<string>();
    for (const field of next.fields) {
      const fieldId = field.fieldId;
      try {
        const oldField = previous.fields.find((entry) => entry.fieldId === fieldId);
        const value = item.values[fieldId];
        const converted = Object.hasOwn(replacement, fieldId) ? replacement[fieldId]
          : oldField && value !== undefined ? convertValue(value, oldField, field) : undefined;
        values[fieldId] = parseCollectionValues({ [fieldId]: converted }, { ...next, fields: [{ ...field, key: fieldId }] })[fieldId]!;
      } catch (error) {
        if (!(error instanceof DocumentValidationError)) throw error;
        failingFields.add(fieldId);
        problems.push({ ...target, fieldId, code: "conversion", message: error.reason });
      }
    }
    problems.push(...cmsValueProblems(next, values).filter(({ fieldId }) => fieldId === undefined || !failingFields.has(fieldId)).map((problem) => ({ ...problem, ...target })));
    items.push({ ...target, tombstoned: item.tombstoned, previousRevision: item.revision, values });
  }
  if (replacementByItem.size > 0) fail("replacements", "replacement item is outside the migration");
  return { fromRevision: before.schemaRevision, schema, items, removedItems, changes,
    problems: [...problems, ...cmsReferenceProblems(schema, items.filter(({ tombstoned }) => !tombstoned)), ...(impact?.(before, schema, changes, items) ?? [])] };
}

/** The supplied items form a complete editable or published view. References resolve inside their locale. */
export function cmsReferenceProblems(schema: CmsSchema, items: readonly (CmsItemKey & { readonly locale: string; readonly values: CollectionValues })[]): CmsProblem[] {
  const visible = new Set(items.map(localizedKey));
  return items.flatMap((item) => cmsCollection(schema, item.collectionId).fields.flatMap((field): CmsProblem[] => {
    if (field.type !== "reference") return [];
    const ids = item.values[field.fieldId];
    if (!Array.isArray(ids)) return [];
    return ids.some((id) => !visible.has(localizedKey({ locale: item.locale, collectionId: field.collectionId, itemId: String(id) })))
      ? [{ code: "reference", message: "参照先を選び直してください。", collectionId: item.collectionId, itemId: item.itemId, fieldId: field.fieldId, locale: item.locale }] : [];
  }));
}
