import type { CmsSchema, CmsCollection } from "../src/cms-v2.js";
import type { CollectionValues } from "../src/collection-model.js";

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
