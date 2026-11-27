import {
  cmsLocalizationItemKey, cmsLocalizationStatus, type CmsLocalizationCollection, type CmsLocalizationField,
  type CmsLocalizationOverlay, type CmsItemRevision, type CmsSchema
} from "../src/cms-v2.js";
import { cmsCollection } from "../src/cms-v2-schema.js";
import { richMarks, type LocalizationItem, type LocalizationItemSummary, type LocalizationOverview, type LocalizationWorkspaceUnit } from "../src/localization-workspace-model.js";

export type CmsLocalizationView = {
  readonly schema: CmsSchema;
  readonly source: CmsItemRevision;
  /** The current source-locale draft differs from the published source revision. */
  readonly sourceDraftPending: boolean;
  readonly collection: CmsLocalizationCollection;
  readonly overlay: CmsLocalizationOverlay;
  readonly updatedAt?: string | null;
};

export function cmsLocalizedSchema(schema: CmsSchema, targetLocale: string): CmsSchema {
  const root = `/${targetLocale}/cms`;
  return { ...schema, collections: schema.collections.map((collection) => {
    if (collection.pathPrefix === null) return collection;
    let relative = collection.pathPrefix.replace(/^\/cms(?=\/)/u, "");
    if (relative === "/") relative = `/${collection.id.toLowerCase()}/`;
    if (!relative.startsWith("/")) relative = `/${relative}`;
    return { ...collection, pathPrefix: `${root}${relative}` };
  }) };
}

export function cmsLocalizationTargetLocale(sourceLocale: string): "ja" | "en" {
  const family = sourceLocale.split("-", 1)[0]!.toLowerCase();
  if (family === "ja") return "en";
  if (family === "en") return "ja";
  throw new Error("Studio CMS localization currently supports ja and en locales.");
}

function title(view: CmsLocalizationView): string {
  const collection = cmsCollection(view.schema, view.source.collectionId);
  const value = collection.titleField === null ? view.source.itemId : view.source.values[collection.titleField];
  return typeof value === "string" && value ? value.slice(0, 1000) : view.source.itemId;
}

export function cmsLocalizationSummary(view: CmsLocalizationView): LocalizationItemSummary {
  const status = cmsLocalizationStatus(view.overlay, view.collection);
  const definition = cmsCollection(view.schema, view.source.collectionId);
  const slug = definition.slugField === null ? null : view.source.values[definition.slugField];
  const translated = status.units - status.missing;
  const state = view.collection.issues.length > 0 ? "excluded" : status.complete ? "reviewed" : status.reviewNeeded > 0 ? "source-changed"
    : translated > 0 ? "draft" : "untranslated";
  return {
    key: cmsLocalizationItemKey(view.source.collectionId, view.source.itemId), groupId: view.source.collectionId, title: title(view),
    path: definition.pathPrefix && typeof slug === "string" && slug ? `${definition.pathPrefix}${slug}` : null,
    state, excludedReason: view.collection.issues.length ? "リッチテキストの安全な翻訳adapterが未接続です。" : null,
    totalUnits: status.units, reviewedUnits: translated, imagesUnreviewed: 0,
    sourceDraftPending: view.sourceDraftPending, updatedAt: view.updatedAt ?? null, updatedBy: null
  };
}

export function cmsLocalizationStatusLabel(view: CmsLocalizationView): ReturnType<typeof cmsLocalizationStatus> {
  return cmsLocalizationStatus(view.overlay, view.collection);
}

function workspaceUnit(field: CmsLocalizationField, view: CmsLocalizationView): LocalizationWorkspaceUnit {
  const entry = view.overlay.entries.find(({ unitId }) => unitId === field.unitId);
  const detail = cmsLocalizationStatus(view.overlay, view.collection).details.find(({ unitId }) => unitId === field.unitId);
  const state = detail?.state ?? "missing";
  const candidateValue = entry?.candidate?.value;
  const candidate = entry?.candidate && (field.kind === "text" ? typeof candidateValue === "string"
    : typeof candidateValue === "object" && candidateValue !== null && "kind" in candidateValue && candidateValue.kind === "rich-text")
    ? { candidateId: `cms_candidate_${entry.candidate.version}`, value: candidateValue as string | Extract<typeof field.sourceValue, { kind: "rich-text" }> }
    : null;
  const base = { unitId: field.unitId, label: field.label, section: field.label, required: true,
    version: String(view.overlay.version), sourceVersion: view.source.revision, state,
    updatedAt: null, updatedBy: null, editOrigin: entry?.editOrigin ?? null };
  if (field.kind === "rich-text") {
    const source = field.sourceValue as Extract<typeof field.sourceValue, { kind: "rich-text" }>;
    const value = entry?.draftValue && typeof entry.draftValue === "object" && entry.draftValue.kind === "rich-text"
      ? entry.draftValue : null;
    const richCandidate = candidate && typeof candidate.value !== "string" ? candidate as { candidateId: string; value: typeof source } : null;
    return { ...base, kind: "rich-text", source, value, previousSource: null, candidate: richCandidate };
  }
  const source = field.sourceValue as string;
  const value = typeof entry?.draftValue === "string" ? entry.draftValue : null;
  const textCandidate = candidate && typeof candidate.value === "string" ? candidate as { candidateId: string; value: string } : null;
  const definition = cmsCollection(view.schema, view.source.collectionId).fields.find(({ fieldId }) => fieldId === field.identity.fieldId)!;
  return { ...base, kind: "text", source, value, previousSource: null, candidate: textCandidate,
    marks: [], maxLength: field.maxLength ?? null, singleLine: definition.type === "text" || definition.type === "slug" || definition.type === "url" };
}

export function cmsLocalizationItem(view: CmsLocalizationView): LocalizationItem {
  const summary = cmsLocalizationSummary(view);
  const units = view.collection.fields.map((field) => {
    const unit = workspaceUnit(field, view);
    return unit.kind === "rich-text" ? { ...unit, marks: richMarks(unit.source) } : unit;
  });
  return { ...summary, units, previews: [], job: null };
}

export function cmsLocalizationOverview(input: {
  readonly schema: CmsSchema;
  readonly sourceLocale: string;
  readonly views: readonly CmsLocalizationView[];
  readonly canEdit: boolean;
}): LocalizationOverview {
  const sourceLocale = input.sourceLocale.split("-", 1)[0] as "ja" | "en", targetLocale = cmsLocalizationTargetLocale(input.sourceLocale);
  const summaries = input.views.map(cmsLocalizationSummary);
  return {
    version: input.schema.schemaRevision, sourceLocale, targetLocale,
    languages: sourceLocale === "ja" ? { source: "日本語", target: "English" } : { source: "English", target: "日本語" },
    permissions: input.canEdit ? ["edit", "review"] : [],
    groups: input.schema.collections.map((collection) => {
      const rows = summaries.filter((summary) => summary.groupId === collection.id);
      return { id: collection.id, label: collection.label, items: rows.length,
        needsWork: rows.filter((summary) => summary.state !== "reviewed").length,
        reviewed: rows.filter((summary) => summary.state === "reviewed").length,
        excluded: rows.filter((summary) => summary.excludedReason !== null).length };
    }),
    release: { current: null, pending: null }, blockers: [], catalog: { state: "current" }, preview: null,
    settings: { version: input.schema.schemaRevision, autoDraft: false, translator: { connected: false }, queue: { waiting: 0, failed: 0, nextRetryAt: null } }
  };
}
