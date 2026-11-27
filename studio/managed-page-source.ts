import { parsePageDocument } from "../src/document.js";
import type { SiteStyles } from "../src/site-styles.js";
import { walkNodes } from "../src/node-tree.js";
import type { PageDocument } from "../src/types.js";
import type { CmsBucket, CmsStore } from "./managed-cms-store.js";

export const MAX_MANAGED_PAGE_BYTES = 2 * 1024 * 1024;

type SourceScope = { readonly site_id: string; readonly page_id: string; readonly locale: string; readonly revision: number };
export type PageSourceRow = SourceScope & {
  readonly document_json: string;
  readonly document_key: string | null;
  readonly document_digest: string | null;
};

// The longest managed URL fits within a 253-character host, port, 63-character slug, and 160-character page path.
const MAX_MANAGED_LINK_LENGTH = 512;
const VERSION_FILENAME = /^(?:legacy|p\.[0-9a-f-]{36})\.json$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function sourcePrefix({ site_id, page_id, locale, revision }: SourceScope): string {
  return `sites/${encodeURIComponent(site_id)}/pages/${encodeURIComponent(page_id)}/${encodeURIComponent(locale)}/${revision}/`;
}

async function sha256(bytes: BufferSource): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function checkScope(document: PageDocument, row: SourceScope): PageDocument {
  if (!document || document.siteId !== row.site_id || document.pageId !== row.page_id
    || document.locale !== row.locale || document.revision !== row.revision) throw new Error("managed page source scope mismatch");
  return document;
}

export async function readPageSourceObject(bucket: CmsBucket, row: SourceScope, key: string, digest: string, siteStyles?: SiteStyles): Promise<PageDocument> {
  const prefix = sourcePrefix(row);
  if (!key.startsWith(prefix) || !VERSION_FILENAME.test(key.slice(prefix.length))) throw new Error("invalid managed page source key");
  const object = await bucket.get(key);
  if (!object) throw new Error("managed page source missing");
  const bytes = await object.arrayBuffer();
  if (await sha256(bytes) !== digest) throw new Error("managed page source digest mismatch");
  const input = JSON.parse(decoder.decode(bytes));
  return checkScope(parsePageDocument(input, {}, siteStyles ? { siteStyles } : {}), row);
}

async function putSource(bucket: CmsBucket, document: PageDocument, version: string, json: string, bytes: Uint8Array<ArrayBuffer>) {
  const key = sourcePrefix({ site_id: document.siteId, page_id: document.pageId, locale: document.locale, revision: document.revision }) + version + ".json";
  const digest = await sha256(bytes);
  if (await bucket.put(key, json, { onlyIf: new Headers({ "If-None-Match": "*" }) }) === null) {
    const existing = await bucket.get(key);
    const stored = existing && new Uint8Array(await existing.arrayBuffer());
    if (!stored || stored.length !== bytes.length || stored.some((byte, index) => byte !== bytes[index])) throw new Error("managed page source collision");
  }
  // Remove query/fragment data. Only root-relative paths and the public HTTPS URL can match the warning lookup.
  const links = walkNodes(document).flatMap(({ node }) => {
    if (node.type !== "element") return [];
    const href = node.attrs?.href;
    if (typeof href !== "string" || !(href.startsWith("/") && !href.startsWith("//") || href.startsWith("https://"))) return [];
    const destination = href.split(/[?#]/u, 1)[0]!;
    return destination.length <= MAX_MANAGED_LINK_LENGTH ? [[node.id, destination]] : [];
  });
  return { key, digest, linkIndex: JSON.stringify(links) };
}

export async function storePageSource(bucket: CmsBucket, document: PageDocument, version: string) {
  const json = JSON.stringify(document), bytes = encoder.encode(json);
  return bytes.length <= MAX_MANAGED_PAGE_BYTES ? putSource(bucket, document, version, json, bytes) : null;
}

export async function readPageSource(store: Pick<CmsStore, "db" | "bucket"> | undefined, row: PageSourceRow, siteStyles?: SiteStyles): Promise<PageDocument> {
  if (row.document_key !== null) {
    if (!store || row.document_digest === null) throw new Error("managed page source unavailable");
    return readPageSourceObject(store.bucket, row, row.document_key, row.document_digest, siteStyles);
  }

  const document = checkScope(parsePageDocument(JSON.parse(row.document_json), {}, siteStyles ? { siteStyles } : {}), row);
  if (!store) return document;
  try {
    // Old rows have no separate source version ID. All readers of the same legacy revision use the same key and exact bytes.
    const source = await putSource(store.bucket, document, "legacy", row.document_json, encoder.encode(row.document_json));
    const result = await store.db.prepare(`UPDATE managed_page_versions
      SET document_json = '{}', document_key = ?1, document_digest = ?2, link_index_json = ?3
      WHERE site_id = ?4 AND page_id = ?5 AND locale = ?6 AND revision = ?7 AND document_key IS NULL`)
      .bind(source.key, source.digest, source.linkIndex, row.site_id, row.page_id, row.locale, row.revision).all();
    if (!result.success) throw new Error("legacy managed page source update failed");
  } catch (error) {
    // The body from this read is still usable if externalization cannot be confirmed.
    console.error("NIHO Studio legacy page source migration failed", error instanceof Error ? error.name : "UnknownError");
  }
  return document;
}
