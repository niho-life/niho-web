import { ASSET_LIMITS, assetKey } from "./assets.js";
import { parseGalleryEntries } from "./collection-model.js";
import type { CmsItemRevision, CmsSchema } from "./cms-v2-schema.js";
import type { AssetReference } from "./types.js";
import { fail, keys, line, parseAssetReference, publicImageUrl, record } from "./validation-utils.js";

export type CmsPublicAsset = {
  readonly reference: Readonly<AssetReference>;
  readonly url: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly altText: string;
};

function dimension(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > ASSET_LIMITS.dimension)
    fail(path, "invalid image dimension");
  return value;
}

export function parseCmsPublicAssets(input: unknown): Map<string, CmsPublicAsset> {
  const result = new Map<string, CmsPublicAsset>();
  if (input === undefined) return result;
  if (!Array.isArray(input)) fail("assetManifest", "expected an array");
  for (const [index, entry] of input.entries()) {
    const at = `assetManifest[${index}]`, value = record(entry, at);
    keys(value, ["reference", "url", "width", "height", "altText"], at);
    const reference = parseAssetReference(value.reference, `${at}.reference`), key = assetKey(reference);
    if (result.has(key)) fail(at, "duplicate public asset");
    result.set(key, {
      reference, url: publicImageUrl(value.url, `${at}.url`),
      width: dimension(value.width, `${at}.width`), height: dimension(value.height, `${at}.height`),
      altText: line(value.altText, `${at}.altText`, ASSET_LIMITS.altLength, true)
    });
  }
  return result;
}

export function* cmsReleaseAssetUses(schema: CmsSchema, items: readonly CmsItemRevision[]) {
  const fields = new Map(schema.collections.map(({ id, fields }) =>
    [id, fields.filter(({ type }) => type === "image" || type === "gallery")] as const));
  for (const { collectionId, itemId, values } of items) {
    const collection = fields.get(collectionId);
    if (!collection) fail("snapshot.items", "unknown CMS collection");
    for (const { fieldId, type } of collection) {
      const at = `snapshot.items.${collectionId}.${itemId}.${fieldId}`;
      const value = values[fieldId];
      if (value == null) continue;
      const images = type === "image" ? [value] : parseGalleryEntries(value, at).map(({ image }) => image);
      for (const image of images) {
        if (image === null) continue;
        const reference = typeof image === "string" ? null : parseAssetReference(image, at);
        yield { collectionId, itemId, fieldId, reference };
      }
    }
  }
}

/** Collect only stable references from the exact revision selection supplied to the host adapter. */
export function collectCmsReleaseAssetReferences(schema: CmsSchema, items: readonly CmsItemRevision[]): AssetReference[] {
  const references = new Map<string, AssetReference>();
  for (const { reference } of cmsReleaseAssetUses(schema, items)) {
    if (reference !== null) references.set(assetKey(reference), reference);
  }
  return [...references.values()];
}

/** Stored and delivered snapshots must contain exactly the assets used by their image and gallery fields. */
export function parseCmsReleaseAssetManifest(schema: CmsSchema, items: readonly CmsItemRevision[], input: unknown): CmsPublicAsset[] {
  const entries = parseCmsPublicAssets(input);
  const used = new Set<string>();
  for (const { reference } of cmsReleaseAssetUses(schema, items)) {
    if (reference === null) fail("snapshot.items", "expected a stable public asset reference");
    const key = assetKey(reference);
    if (!entries.has(key)) fail("assetManifest", "unresolved public asset");
    used.add(key);
  }
  if (used.size !== entries.size) fail("assetManifest", "unreferenced public asset");
  return [...entries.values()];
}
