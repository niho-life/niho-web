import { ASSET_LIMITS, INSERTABLE_IMAGE_TYPES, type AssetProvider, type LibraryAsset } from "../src/assets.js";
import { parseCmsPublicAssets, type CmsPublicAsset } from "../src/cms-v2-assets.js";
import type { AssetReference } from "../src/types.js";

/** Studio 内サイトの画像ライブラリ。バイト列は非公開 R2、公開はサイト共通 origin の /_niho/assets/ から返す。 */
export const STUDIO_UPLOAD_PROVIDER = "studio-upload";
export const MIGRATED_PROVIDER = "kamakura-source";
export const STUDIO_ASSET_MAX_BYTES = 20 * 1024 * 1024;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const EXTENSION: Readonly<Record<string, string>> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif", "image/gif": "gif" };
const MIME_BY_EXTENSION = Object.fromEntries(Object.entries(EXTENSION).map(([mime, extension]) => [extension, mime]));
const DELIVERY_PATH = /^\/_niho\/assets\/(img_[a-z0-9]{24})\.(jpg|png|webp|avif|gif)$/u;
const ASSET_ID = /^img_[a-z0-9]{24}$/u;

type Statement = { bind(...values: readonly unknown[]): { first<T>(): Promise<T | null>; all<T>(): Promise<{ readonly success: boolean; readonly results?: readonly T[]; readonly meta?: { readonly changes?: number } }> } };
export type AssetDatabase = { prepare(query: string): Statement };
export type AssetBucket = {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; readonly body?: ReadableStream | null } | null>;
  put(key: string, value: ArrayBuffer, options: { onlyIf: Headers }): Promise<unknown>;
};

type AssetRow = {
  readonly asset_id: string; readonly content_sha256: string; readonly mime_type: string; readonly byte_length: number;
  readonly width: number | null; readonly height: number | null; readonly name: string; readonly created_at: number; readonly rowid?: number;
};
const COLUMNS = "asset_id, content_sha256, mime_type, byte_length, width, height, name, created_at, rowid";

/** 配信 URL。拡張子は形式から決まり、要求側の拡張子が合わなければ 404 になる。 */
export function studioAssetUrl(origin: string, assetId: string, mimeType: string): string {
  return `${origin}/_niho/assets/${assetId}.${EXTENSION[mimeType] ?? "bin"}`;
}

export function isStudioAssetReference(reference: AssetReference): boolean {
  return reference.provider === STUDIO_UPLOAD_PROVIDER && ASSET_ID.test(reference.id);
}

/** 先頭バイトから形式を読む。SVG などは null。 */
export function sniffImageType(bytes: Uint8Array): (typeof INSERTABLE_IMAGE_TYPES)[number] | null {
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 3) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (bytes.length >= 16 && ascii(4, 4) === "ftyp") {
    const boxLength = Math.min(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0), 64, bytes.length);
    const brands = [ascii(8, 4)];
    for (let offset = 16; offset + 4 <= boxLength; offset += 4) brands.push(ascii(offset, 4));
    if (brands.some((brand) => brand === "avif" || brand === "avis")) return "image/avif";
  }
  return null;
}

function validDimension(value: number): number | null {
  return Number.isSafeInteger(value) && value >= 1 && value <= ASSET_LIMITS.dimension ? value : null;
}

/** PNG・JPEG・GIF・WebP の幅と高さ。読めなければ null（AVIF など）。 */
export function readImageDimensions(bytes: Uint8Array, mimeType: string): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pair = (width: number, height: number) => {
    const w = validDimension(width), h = validDimension(height);
    return w === null || h === null ? null : { width: w, height: h };
  };
  try {
    if (mimeType === "image/png") return bytes.length >= 24 ? pair(view.getUint32(16), view.getUint32(20)) : null;
    if (mimeType === "image/gif") return bytes.length >= 10 ? pair(view.getUint16(6, true), view.getUint16(8, true)) : null;
    if (mimeType === "image/jpeg") {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) { offset += 1; continue; }
        const marker = bytes[offset + 1]!;
        if (marker === 0xff) { offset += 1; continue; }
        if (marker === 0xd8 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) { offset += 2; continue; }
        const length = view.getUint16(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return pair(view.getUint16(offset + 7), view.getUint16(offset + 5));
        }
        offset += 2 + length;
      }
      return null;
    }
    if (mimeType === "image/webp") {
      const chunk = String.fromCharCode(...bytes.subarray(12, 16));
      if (chunk === "VP8 " && bytes.length >= 30) return pair(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
      if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
        const bits = view.getUint32(21, true);
        return pair((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
      }
      if (chunk === "VP8X" && bytes.length >= 30) {
        return pair((bytes[24]! | bytes[25]! << 8 | bytes[26]! << 16) + 1, (bytes[27]! | bytes[28]! << 8 | bytes[29]! << 16) + 1);
      }
    }
  } catch { return null; }
  return null;
}

function randomAssetId(): string {
  const result: string[] = [];
  while (result.length < 24) {
    for (const byte of crypto.getRandomValues(new Uint8Array(48))) {
      if (byte < 252 && result.length < 24) result.push(ID_ALPHABET[byte % 36]!);
    }
  }
  return `img_${result.join("")}`;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 公開用の素材一覧への変換。サイトに属する ID だけが解決される。 */
export async function resolveStudioAssets(db: AssetDatabase, siteId: string, references: readonly AssetReference[],
  publicOrigin: string | undefined): Promise<CmsPublicAsset[]> {
  const ids = [...new Set(references.filter(isStudioAssetReference).map(({ id }) => id))];
  if (!ids.length || !publicOrigin) return [];
  const rows = await db.prepare(`SELECT ${COLUMNS} FROM managed_site_assets WHERE site_id = ?1 AND asset_id IN (SELECT value FROM json_each(?2))`)
    .bind(siteId, JSON.stringify(ids)).all<AssetRow>();
  if (!rows.success) throw new Error("studio asset lookup failed");
  return (rows.results ?? []).map((row) => ({
    reference: { provider: STUDIO_UPLOAD_PROVIDER, id: row.asset_id }, url: studioAssetUrl(publicOrigin, row.asset_id, row.mime_type),
    width: row.width, height: row.height, altText: ""
  }));
}

/** GET {PUBLIC_SITES_ORIGIN}/_niho/assets/{id}.{ext}。対象でないパスは null。 */
export async function servePublicStudioAsset(request: Request, url: URL, env: { readonly DB: AssetDatabase; readonly CMS_OBJECTS: unknown }): Promise<Response | null> {
  const match = DELIVERY_PATH.exec(url.pathname);
  if (!match) return null;
  const failure = (status: number) => new Response("Not Found", { status, headers: {
    "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex" } });
  if (request.method !== "GET" && request.method !== "HEAD" || url.search) return failure(404);
  const [, assetId, extension] = match;
  const row = await env.DB.prepare("SELECT site_id, content_sha256, mime_type, byte_length FROM managed_site_assets WHERE asset_id = ?1")
    .bind(assetId).first<{ site_id: string; content_sha256: string; mime_type: string; byte_length: number }>();
  if (!row || MIME_BY_EXTENSION[extension!] !== row.mime_type) return failure(404);
  const object = await (env.CMS_OBJECTS as AssetBucket).get(`sites/${row.site_id}/assets/${row.content_sha256}`);
  if (!object) return failure(404);
  const headers = new Headers({
    "Content-Type": row.mime_type, "Content-Length": String(row.byte_length),
    "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox"
  });
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(object.body ?? await object.arrayBuffer(), { status: 200, headers });
}

const READ_ONLY = { upload: false, editMetadata: false, delete: false, folders: false, acquire: false } as const;
const PROVIDERS: readonly AssetProvider[] = Object.freeze([
  { id: STUDIO_UPLOAD_PROVIDER, kind: "upload", label: "アップロード", origin: "この Project にアップロードした画像", status: "available",
    capabilities: { upload: true, editMetadata: false, delete: false, folders: false, acquire: false } },
  { id: MIGRATED_PROVIDER, kind: "cms", label: "取り込み", origin: "移行元から取り込んだ画像（読み取り専用）", status: "available", capabilities: READ_ONLY }
]);

function libraryAsset(siteId: string, publicOrigin: string, row: AssetRow): LibraryAsset {
  const url = studioAssetUrl(publicOrigin, row.asset_id, row.mime_type);
  return {
    provider: STUDIO_UPLOAD_PROVIDER, id: row.asset_id, siteId, kind: "image", status: "ready", name: row.name, mimeType: row.mime_type,
    bytes: row.byte_length, ...(row.width === null ? {} : { width: row.width }), ...(row.height === null ? {} : { height: row.height }),
    alt: "", thumbnailUrl: url, version: row.content_sha256, updatedAt: new Date(row.created_at * 1000).toISOString()
  };
}

function legacyMime(url: string): { mimeType: string; kind: LibraryAsset["kind"] } {
  const extension = /\.([A-Za-z0-9]{2,5})(?:$|\?)/u.exec(url)?.[1]?.toLowerCase();
  const image = extension === "jpeg" ? "jpg" : extension;
  const mime = image && MIME_BY_EXTENSION[image];
  if (mime) return { mimeType: mime, kind: "image" };
  if (extension === "svg") return { mimeType: "image/svg+xml", kind: "image" };
  if (extension === "pdf") return { mimeType: "application/pdf", kind: "pdf" };
  return { mimeType: "application/octet-stream", kind: "other" };
}

async function legacyAssets(bucket: AssetBucket, siteId: string): Promise<CmsPublicAsset[]> {
  const object = await bucket.get(`sites/${siteId}/migration/legacy-assets.json`);
  if (!object) return [];
  try {
    const manifest = JSON.parse(new TextDecoder().decode(await object.arrayBuffer())) as { formatVersion?: unknown; siteId?: unknown; assets?: unknown };
    if (manifest.formatVersion !== 1 || manifest.siteId !== siteId || !Array.isArray(manifest.assets)) return [];
    return [...parseCmsPublicAssets(manifest.assets).values()];
  } catch { return []; }
}

export type AssetListInput = { readonly provider?: string; readonly cursor?: string; readonly limit?: number };

export function parseAssetListInput(value: Record<string, unknown>): AssetListInput | null {
  if (Object.keys(value).some((key) => key !== "provider" && key !== "cursor" && key !== "limit")) return null;
  const { provider, cursor, limit } = value;
  if (provider !== undefined && provider !== STUDIO_UPLOAD_PROVIDER && provider !== MIGRATED_PROVIDER) return null;
  if (cursor !== undefined && (typeof cursor !== "string" || !/^[rk][0-9]{1,15}$/u.test(cursor))) return null;
  if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > ASSET_LIMITS.listAssets)) return null;
  return { ...(provider === undefined ? {} : { provider }), ...(cursor === undefined ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) };
}

/** 新しい順。provider 省略時はアップロード、続けて取り込みの順に返す。 */
export async function listStudioAssets(db: AssetDatabase, bucket: AssetBucket, siteId: string, publicOrigin: string, input: AssetListInput) {
  const limit = input.limit ?? ASSET_LIMITS.pageSize;
  const upload = { accept: [...INSERTABLE_IMAGE_TYPES], maxBytes: STUDIO_ASSET_MAX_BYTES };
  const phase = input.cursor?.[0] === "k" ? "k" : input.provider === MIGRATED_PROVIDER ? "k" : "r";
  const position = input.cursor ? Number(input.cursor.slice(1)) : phase === "k" ? 0 : Number.MAX_SAFE_INTEGER;
  if (phase === "r") {
    const rows = await db.prepare(`SELECT ${COLUMNS} FROM managed_site_assets WHERE site_id = ?1 AND rowid < ?2 ORDER BY rowid DESC LIMIT ?3`)
      .bind(siteId, position, limit + 1).all<AssetRow>();
    if (!rows.success) throw new Error("studio asset list failed");
    const page = (rows.results ?? []).slice(0, limit);
    const more = (rows.results ?? []).length > limit;
    let nextCursor: string | undefined = more ? `r${page.at(-1)!.rowid}` : undefined;
    const assets = page.map((row) => libraryAsset(siteId, publicOrigin, row));
    if (!more && input.provider === undefined) {
      // アップロードが1ページに満たなければ、続けて取り込んだ画像で埋める（「まだありません」と「さらに読み込む」が並ばないように）。
      const legacy = await legacyAssets(bucket, siteId), fill = legacy.slice(0, limit - assets.length);
      assets.push(...fill.map((asset) => legacyLibraryAsset(siteId, asset)));
      nextCursor = legacy.length > fill.length ? `k${fill.length}` : undefined;
    }
    return { assets, ...(nextCursor ? { nextCursor } : {}), upload, providers: PROVIDERS };
  }
  const all = await legacyAssets(bucket, siteId);
  const page = all.slice(position, position + limit);
  return {
    assets: page.map((asset) => legacyLibraryAsset(siteId, asset)),
    ...(position + limit < all.length ? { nextCursor: `k${position + limit}` } : {}), upload, providers: PROVIDERS
  };
}

function legacyLibraryAsset(siteId: string, asset: CmsPublicAsset): LibraryAsset {
  const { mimeType, kind } = legacyMime(asset.url);
  // 説明の無い取り込み画像は、ID ではなく元のファイル名で見せる。
  const fileName = (() => { try { return decodeURIComponent(new URL(asset.url).pathname.split("/").at(-1) ?? ""); } catch { return ""; } })();
  return { provider: MIGRATED_PROVIDER, id: asset.reference.id, siteId, kind, status: "ready", name: (asset.altText || fileName || asset.reference.id).slice(0, ASSET_LIMITS.nameLength),
    mimeType, bytes: 0, ...(asset.width === null ? {} : { width: asset.width }), ...(asset.height === null ? {} : { height: asset.height }),
    alt: asset.altText, thumbnailUrl: asset.url, version: "legacy", updatedAt: new Date(0).toISOString() };
}

export type UploadOutcome =
  | { readonly status: "uploaded"; readonly asset: LibraryAsset }
  | { readonly status: "rejected"; readonly reason: "type" | "size" | "invalid" };

/** 受け取った本文の検査と保存。入力の検査はここで 1 回だけ行う。 */
export async function uploadStudioAsset(db: AssetDatabase, bucket: AssetBucket, siteId: string, publicOrigin: string, subject: string,
  request: Request): Promise<UploadOutcome> {
  const declared = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!(INSERTABLE_IMAGE_TYPES as readonly string[]).includes(declared)) return { status: "rejected", reason: "type" };
  let name: string;
  try { name = decodeURIComponent(request.headers.get("X-Asset-Name") ?? ""); } catch { return { status: "rejected", reason: "invalid" }; }
  if (!name.trim() || name.length > ASSET_LIMITS.nameLength || /[\u0000-\u001f\u007f]/u.test(name)) return { status: "rejected", reason: "invalid" };
  const lengthHeader = request.headers.get("Content-Length");
  if (lengthHeader === null || !/^\d{1,15}$/u.test(lengthHeader)) return { status: "rejected", reason: "invalid" };
  const length = Number(lengthHeader);
  if (length > STUDIO_ASSET_MAX_BYTES) return { status: "rejected", reason: "size" };
  if (length < 1 || !request.body) return { status: "rejected", reason: "invalid" };
  const bytes = new Uint8Array(length), reader = request.body.getReader();
  let offset = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (chunk.value.byteLength > length - offset) { await reader.cancel(); return { status: "rejected", reason: "size" }; }
    bytes.set(chunk.value, offset);
    offset += chunk.value.byteLength;
  }
  if (offset !== length) return { status: "rejected", reason: "invalid" };
  if (sniffImageType(bytes) !== declared) return { status: "rejected", reason: "type" };
  const dimensions = readImageDimensions(bytes, declared);
  const sha = await sha256Hex(bytes.buffer);
  const find = () => db.prepare(`SELECT ${COLUMNS} FROM managed_site_assets WHERE site_id = ?1 AND content_sha256 = ?2`).bind(siteId, sha).first<AssetRow>();
  let row = await find();
  if (!row) {
    // 名前が内容そのものなので、既にあれば同じバイト列。put が失敗した場合は D1 に書かない。
    await bucket.put(`sites/${siteId}/assets/${sha}`, bytes.buffer, { onlyIf: new Headers({ "If-None-Match": "*" }) });
    const inserted = await db.prepare(`INSERT INTO managed_site_assets (site_id, asset_id, content_sha256, mime_type, byte_length, width, height, name, created_by_subject)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT (site_id, content_sha256) DO NOTHING`)
      .bind(siteId, randomAssetId(), sha, declared, length, dimensions?.width ?? null, dimensions?.height ?? null, name, subject).all();
    if (!inserted.success) throw new Error("studio asset insert failed");
    row = await find();
  }
  if (!row) throw new Error("studio asset insert failed");
  return { status: "uploaded", asset: libraryAsset(siteId, publicOrigin, row) };
}

const LIST_BODY_MAX_BYTES = 4096;

/** 本文を最大 limit バイトまで読む。超えたら null。 */
async function readCappedText(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > limit) { await reader.cancel(); return null; }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

/** assets.list（POST）と assets.upload（PUT）。認可・scope は呼び出し側（worker）で済んでいる。 */
export async function managedAssetsOperation(request: Request, operation: "assets.list" | "assets.upload", store: { readonly db: AssetDatabase; readonly bucket: AssetBucket },
  siteId: string, publicOrigin: string, subject: string): Promise<Response> {
  if (operation === "assets.upload") {
    const result = await uploadStudioAsset(store.db, store.bucket, siteId, publicOrigin, subject, request);
    return json(result, result.status === "uploaded" ? 200 : result.reason === "size" ? 413 : 400);
  }
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!/^\d{1,5}$/u.test(declared) || Number(declared) > LIST_BODY_MAX_BYTES)) return json({ error: "invalid_request" }, 400);
  // 長さの宣言が無い要求もあるので、本文は上限まで読んで打ち切る。
  const text = await readCappedText(request, LIST_BODY_MAX_BYTES);
  if (text === null) return json({ error: "invalid_request" }, 400);
  let body: unknown;
  try { body = text.trim() === "" ? {} : JSON.parse(text); } catch { return json({ error: "invalid_request" }, 400); }
  const input = body && typeof body === "object" && !Array.isArray(body) ? parseAssetListInput(body as Record<string, unknown>) : null;
  if (!input) return json({ error: "invalid_request" }, 400);
  return json(await listStudioAssets(store.db, store.bucket, siteId, publicOrigin, input));
}
