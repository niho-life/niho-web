import type { CmsSchema, CmsCollection, CmsReleaseSnapshot } from "../src/cms-v2.js";
import type { CollectionValues } from "../src/collection-model.js";

export const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/gu, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

export function starterCollection(id = "posts", label = "お知らせ", path = "/cms/posts/"): CmsSchema["collections"][number] {
  return {
    id, label, addLabel: "項目を追加", ordering: "publishedAt", pathPrefix: path,
    titleField: "title", slugField: "slug", imageField: null, subtitleField: null,
    capabilities: { create: true, duplicate: false, remove: true, unpublish: true, schedule: true, redirects: true },
    fields: [
      { fieldId: "title", key: "title", label: "タイトル", type: "text", placement: "main", required: true, maxLength: 120 },
      { fieldId: "slug", key: "slug", label: "スラッグ", type: "slug", placement: "side", required: true },
      { fieldId: "body", key: "body", label: "本文", type: "longText", rows: 8, placement: "main" }
    ]
  };
}

export function collectionPathForEditor(collection: CmsCollection, values: CollectionValues) {
  if (collection.pathPrefix === null || collection.slugField === null) return null;
  const slug = values[collection.slugField];
  return typeof slug === "string" && slug ? collection.pathPrefix + slug : null;
}

/** Keep historical links pointed at the current path while an item stays published. */
export function redirectsForCmsItemRelease(redirects: CmsReleaseSnapshot["redirects"], oldPath: string | null | undefined,
  nextPath: string | null, withdraw: boolean): CmsReleaseSnapshot["redirects"] {
  if (!oldPath) return [...redirects];
  return redirects.flatMap((redirect) => {
    if (redirect.to !== oldPath) return [redirect];
    return withdraw || nextPath === null ? [] : [{ ...redirect, to: nextPath }];
  });
}

/** Compare an editable revision with its published snapshot representation. */
export function cmsDraftMatchesPublishedValues(schema: CmsSchema, collectionId: string,
  draftValues: CollectionValues, publishedValues: CollectionValues): boolean {
  const collection = schema.collections.find(({ id }) => id === collectionId);
  if (!collection) return false;

  const comparable: Record<string, unknown> = { ...draftValues };
  for (const field of collection.fields) {
    if (field.type !== "richText") continue;
    const value = comparable[field.fieldId];
    if (typeof value === "string" && value !== "") comparable[field.fieldId] = escapeHtml(value);
  }
  return JSON.stringify(comparable) === JSON.stringify(publishedValues);
}
