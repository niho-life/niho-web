import {
  parseCollectionValues,
  type CollectionAdapter, type CollectionDefinition, type CollectionItem, type CollectionValue, type CollectionValues
} from "../src/collection-model.js";
import {
  KAMAKURA_CMS_BASE, KAMAKURA_CMS_IMAGE_TYPES, KAMAKURA_CMS_LIMITS, KAMAKURA_MEDIA_ORIGIN,
  isKamakuraCmsCollectionId, isKamakuraCmsItemId,
  parseKamakuraCmsConflict, parseKamakuraCmsInvalid, parseKamakuraCmsItemEnvelope, parseKamakuraCmsList, parseKamakuraCmsListChange,
  parseKamakuraCmsListConflict, parseKamakuraCmsRemoved, parseKamakuraCmsSchema, parseKamakuraCmsUploadIntent, parseKamakuraCmsUploadResult,
  type KamakuraCmsItemStatus
} from "./kamakura-cms-contract.js";

/**
 * 鎌倉サイトの CMS を Studio のコレクション画面（CollectionWorkspace）で編集する adapter。
 * 同一 origin の BFF（KAMAKURA_CMS_BASE）だけを呼び、画像本体は upload intent の URL へ credentials なしで直接 PUT する。
 * 応答は BFF と同じ契約の parser で確かめる。
 */
export type KamakuraCmsAdapterOptions = {
  /** サイトの公開 URL の origin（D1 のサイト情報＝Project の site.domains[0]）。プレビューの URL に使う。無ければ null。 */
  readonly siteOrigin: string | null;
};

/** BFF・アップロード先の失敗。message に内部の詳細を入れない。supportId は BFF が返したときだけ。 */
export class KamakuraCmsRequestError extends Error {
  constructor(readonly status: number, readonly supportId: string | null) {
    super("Kamakura CMS request failed");
    this.name = "KamakuraCmsRequestError";
  }
}

type Reply = { readonly status: number; readonly body: unknown };
type Known = { readonly version: string; readonly item: CollectionItem };

const abortError = () => new DOMException("Aborted", "AbortError");
const forbidden = { status: "forbidden" } as const;
const notFound = { status: "not_found" } as const;

function supportId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>).supportId;
  return typeof value === "string" && /^[0-9a-f-]{36}$/u.test(value) ? value : null;
}
function failure(reply: Reply): never {
  throw new KamakuraCmsRequestError(reply.status, supportId(reply.body));
}

function jsonMedia(response: Response): boolean {
  return response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function call(method: "GET" | "POST" | "PUT", path: string, body: Record<string, unknown> | undefined, signal: AbortSignal): Promise<Reply> {
  if (signal.aborted) throw abortError();
  let response: Response;
  try {
    response = await fetch(`${KAMAKURA_CMS_BASE}/${path}`, {
      method, signal, cache: "no-store", credentials: "same-origin", redirect: "error",
      headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  } catch (error) {
    if (signal.aborted) throw abortError();
    throw error;
  }
  if (!jsonMedia(response)) { await response.body?.cancel(); throw new KamakuraCmsRequestError(response.status, null); }
  try { return { status: response.status, body: await response.json() as unknown }; }
  catch {
    if (signal.aborted) throw abortError();
    throw new KamakuraCmsRequestError(response.status, null);
  }
}

function itemPath(collectionId: string, itemId?: string, action?: string): string {
  if (!isKamakuraCmsCollectionId(collectionId) || (itemId !== undefined && !isKamakuraCmsItemId(itemId))) throw new Error("コレクションまたは項目の指定が正しくありません。");
  return `collections/${collectionId}/items${itemId === undefined ? "" : `/${itemId}`}${action === undefined ? "" : `/${action}`}`;
}

function collectionPath(collectionId: string, action: "reorder" | "bulk"): string {
  if (!isKamakuraCmsCollectionId(collectionId)) throw new Error("コレクションの指定が正しくありません。");
  return `collections/${collectionId}/${action}`;
}

/** 文字列の並びは各要素の一致、gallery の並びは各行の id・image・caption の一致。 */
function sameValue(left: CollectionValue | undefined, right: CollectionValue | undefined): boolean {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  const a = left as readonly unknown[], b = right as readonly unknown[];
  return a.length === b.length && a.every((entry, index) => {
    const other = b[index];
    if (entry === other) return true;
    if (typeof entry !== "object" || entry === null || typeof other !== "object" || other === null) return false;
    const x = entry as Record<string, unknown>, y = other as Record<string, unknown>;
    return x.id === y.id && x.image === y.image && x.caption === y.caption;
  });
}

/** ファイル名を BFF の条件（1〜200 字・制御文字なし）に収める。 */
function uploadName(name: string): string {
  let result = "";
  for (const character of name.replace(/[\u0000-\u001f\u007f]/gu, "").trim()) {
    if (result.length + character.length > KAMAKURA_CMS_LIMITS.uploadNameLength) break;
    result += character;
  }
  return result.trim() || "image";
}

function httpsOrigin(value: string | null): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && (url.pathname === "/" || url.pathname === "") ? url.origin : null;
  } catch { return null; }
}

export function createKamakuraCmsAdapter(options: KamakuraCmsAdapterOptions): CollectionAdapter {
  const siteOrigin = httpsOrigin(options.siteOrigin);
  const definitions = new Map<string, CollectionDefinition>();
  /** 項目ごとに最後に読んだ version と項目。saveDraft はこの値との差分だけを送る。 */
  const known = new Map<string, Known>();
  const keyOf = (collectionId: string, itemId: string) => `${collectionId}/${itemId}`;
  const remember = (collectionId: string, item: CollectionItem) => { known.set(keyOf(collectionId, item.id), { version: item.version, item }); };
  const forget = (collectionId: string, itemId: string) => { known.delete(keyOf(collectionId, itemId)); };

  const loadSchema = async (signal: AbortSignal) => {
    const reply = await call("GET", "schema", undefined, signal);
    if (reply.status === 403) return forbidden;
    if (reply.status !== 200) failure(reply);
    const schema = parseKamakuraCmsSchema(reply.body);
    definitions.clear();
    for (const definition of schema.collections) definitions.set(definition.id, definition);
    return schema;
  };
  const definitionFor = async (collectionId: string, signal: AbortSignal): Promise<CollectionDefinition> => {
    if (!definitions.has(collectionId)) await loadSchema(signal);
    const definition = definitions.get(collectionId);
    if (!definition) throw new Error("コレクションの定義を読めませんでした。");
    return definition;
  };

  /** 項目を読み直す。ready なら覚えた値を更新する。 */
  const read = async (collectionId: string, itemId: string, signal: AbortSignal) => {
    const reply = await call("GET", itemPath(collectionId, itemId), undefined, signal);
    if (reply.status === 403) return forbidden;
    if (reply.status === 404) { forget(collectionId, itemId); return notFound; }
    if (reply.status !== 200) failure(reply);
    const result = parseKamakuraCmsItemEnvelope(reply.body, "ready", itemId);
    remember(collectionId, result.item);
    return result;
  };

  /** 書き込みの応答を画面の形にする。成功は覚えた値を更新し、409 は最新の項目つきの conflict にする。 */
  const settle = <S extends KamakuraCmsItemStatus>(reply: Reply, collectionId: string, itemId: string, expected: { readonly code: number; readonly status: S }) => {
    if (reply.status === expected.code) {
      const result = parseKamakuraCmsItemEnvelope(reply.body, expected.status, itemId);
      remember(collectionId, result.item);
      return result;
    }
    if (reply.status === 403) return forbidden;
    if (reply.status === 404) { forget(collectionId, itemId); return notFound; }
    if (reply.status === 409) {
      const conflict = parseKamakuraCmsConflict(reply.body, itemId);
      remember(collectionId, conflict.item);
      return { status: "conflict" as const, item: conflict.item };
    }
    if (reply.status === 422) return { status: "invalid" as const, errors: parseKamakuraCmsInvalid(reply.body).errors };
    return failure(reply);
  };

  const versioned = async (action: string, input: { readonly collectionId: string; readonly itemId: string; readonly version: string }, extra: Record<string, unknown>, expected: { readonly code: number; readonly status: KamakuraCmsItemStatus }, signal: AbortSignal) => {
    const reply = await call("POST", itemPath(input.collectionId, input.itemId, action), { version: input.version, ...extra }, signal);
    return settle(reply, input.collectionId, input.itemId, expected);
  };

  /** reorder・bulk の応答を画面の形にする。成功と 409 は一覧つき。触った項目の覚えた version は捨てる。 */
  const listChange = (reply: Reply, collectionId: string, touched: readonly string[], success: Readonly<Partial<Record<number, "publishing" | "saved">>>) => {
    const status = success[reply.status];
    if (status !== undefined || reply.status === 409) for (const id of touched) forget(collectionId, id);
    if (status !== undefined) return parseKamakuraCmsListChange(reply.body, status);
    if (reply.status === 403) return forbidden;
    if (reply.status === 404) return notFound;
    if (reply.status === 409) return { status: "conflict" as const, items: parseKamakuraCmsListConflict(reply.body).items };
    if (reply.status === 422) return { status: "invalid" as const, errors: parseKamakuraCmsInvalid(reply.body).errors };
    return failure(reply);
  };

  /** 複製の元の version。覚えていなければ読む。 */
  const currentVersion = async (collectionId: string, itemId: string, signal: AbortSignal): Promise<string | typeof forbidden | typeof notFound> => {
    const cached = known.get(keyOf(collectionId, itemId));
    if (cached) return cached.version;
    const result = await read(collectionId, itemId, signal);
    return result.status === "ready" ? result.item.version : result;
  };

  return {
    loadSchema,

    async listItems({ collectionId }, signal) {
      const reply = await call("GET", itemPath(collectionId), undefined, signal);
      if (reply.status === 403) return forbidden;
      if (reply.status !== 200) failure(reply);
      return parseKamakuraCmsList(reply.body, collectionId);
    },

    async loadItem({ collectionId, itemId }, signal) {
      return read(collectionId, itemId, signal);
    },

    async saveDraft({ collectionId, itemId, version, values }, signal) {
      const definition = await definitionFor(collectionId, signal);
      let base = known.get(keyOf(collectionId, itemId));
      if (!base || base.version !== version) {
        // 差分の元が無い・別の version なら読み直す。読んだ version が違えば、上書きせずに競合として返す。
        const latest = await read(collectionId, itemId, signal);
        if (latest.status !== "ready") return latest;
        if (latest.item.version !== version) return { status: "conflict", item: latest.item };
        base = { version, item: latest.item };
      }
      const before: CollectionValues = parseCollectionValues(base.item.values, definition);
      const changed: Record<string, CollectionValue> = {};
      for (const [key, value] of Object.entries(values)) if (!sameValue(before[key], value)) changed[key] = value;
      if (Object.keys(changed).length === 0) return { status: "saved", item: base.item };
      const reply = await call("PUT", itemPath(collectionId, itemId, "draft"), { version, values: changed }, signal);
      return settle(reply, collectionId, itemId, { code: 200, status: "saved" });
    },

    async publish({ redirect, ...input }, signal) {
      // redirect は画面が付けたときだけ送る（無ければ上流の既定＝前のアドレスから移す）
      return versioned("publish", input, redirect === undefined ? {} : { redirect }, { code: 202, status: "publishing" }, signal);
    },

    async createItem({ collectionId }, signal) {
      const reply = await call("POST", itemPath(collectionId), {}, signal);
      if (reply.status === 403) return forbidden;
      if (reply.status === 404) return notFound;
      if (reply.status !== 201) failure(reply);
      const result = parseKamakuraCmsItemEnvelope(reply.body, "created");
      remember(collectionId, result.item);
      return result;
    },

    async discardDraft(input, signal) {
      return versioned("discard-draft", input, {}, { code: 200, status: "saved" }, signal);
    },

    async unpublish(input, signal) {
      // 上流は 202 publishing（サイトから外れるのを待つ）。画面の契約では保存の結果（saved）として返す。
      const result = await versioned("unpublish", input, {}, { code: 202, status: "publishing" }, signal);
      return result.status === "publishing" ? { status: "saved", item: result.item } : result;
    },

    async duplicate({ collectionId, itemId }, signal) {
      // 複製は元の version を確かめる。ほかの人が先に保存していたら、その最新を元にもう一度だけ試す。
      for (let attempt = 0; attempt < 2; attempt++) {
        const version = await currentVersion(collectionId, itemId, signal);
        if (typeof version !== "string") return version;
        const reply = await call("POST", itemPath(collectionId, itemId, "duplicate"), { version }, signal);
        if (reply.status === 201) {
          const result = parseKamakuraCmsItemEnvelope(reply.body, "created");
          if (result.item.id === itemId) throw new Error("複製の結果が正しくありません。");
          remember(collectionId, result.item);
          return result;
        }
        if (reply.status === 403) return forbidden;
        if (reply.status === 404) { forget(collectionId, itemId); return notFound; }
        if (reply.status !== 409) failure(reply);
        remember(collectionId, parseKamakuraCmsConflict(reply.body, itemId).item);
      }
      throw new KamakuraCmsRequestError(409, null);
    },

    async remove({ redirectTo, ...input }, signal) {
      const reply = await call("POST", itemPath(input.collectionId, input.itemId, "remove"), { version: input.version, ...(redirectTo === undefined ? {} : { redirectTo }) }, signal);
      if (reply.status === 200) {
        const result = parseKamakuraCmsRemoved(reply.body);
        forget(input.collectionId, input.itemId);
        return result;
      }
      // 422 は移動先の選び直し（{ field: "", message }）
      return settle(reply, input.collectionId, input.itemId, { code: 200, status: "saved" });
    },

    async schedule({ at, redirect, ...input }, signal) {
      return versioned("schedule", input, { at, ...(redirect === undefined ? {} : { redirect }) }, { code: 200, status: "saved" }, signal);
    },

    async retrySchedule(input, signal) {
      return versioned("retry-schedule", input, {}, { code: 200, status: "saved" }, signal);
    },

    async reorder({ collectionId, ids, from, to }, signal) {
      const reply = await call("POST", collectionPath(collectionId, "reorder"), { ids: [...ids], from, to }, signal);
      // 並べた項目の version は変わる。次に開いたときに読み直す
      return listChange(reply, collectionId, ids, { 202: "publishing" });
    },

    async bulk({ collectionId, action, items }, signal) {
      const reply = await call("POST", collectionPath(collectionId, "bulk"), { action, items: items.map(({ id, version }) => ({ id, version })) }, signal);
      return listChange(reply, collectionId, items.map((item) => item.id), { 202: "publishing", 200: "saved" });
    },

    async cancelSchedule(input, signal) {
      return versioned("cancel-schedule", input, {}, { code: 200, status: "saved" }, signal);
    },

    async uploadImage({ collectionId, file }, signal) {
      if (!KAMAKURA_CMS_IMAGE_TYPES.has(file.type)) return { status: "rejected", reason: "type" };
      if (file.size < 1) return { status: "rejected", reason: "invalid" };
      if (file.size > KAMAKURA_CMS_LIMITS.imageBytes) return { status: "rejected", reason: "size" };
      if (!isKamakuraCmsCollectionId(collectionId)) return { status: "rejected", reason: "invalid" };
      const reply = await call("POST", "uploads/intent", { collectionId, name: uploadName(file.name), mimeType: file.type, bytes: file.size }, signal);
      if (reply.status === 403) return { status: "rejected", reason: "permission" };
      if (reply.status === 413) return { status: "rejected", reason: "size" };
      if (reply.status === 415) return { status: "rejected", reason: "type" };
      if (reply.status === 400 || reply.status === 422) return { status: "rejected", reason: "invalid" };
      if (reply.status !== 201) failure(reply);
      // 行き先は鎌倉の Worker の /internal/studio/cms-upload/<uploadId> だけ（parser が origin とパスを確かめる）。
      const intent = parseKamakuraCmsUploadIntent(reply.body);
      if (signal.aborted) throw abortError();
      let response: Response;
      try {
        response = await fetch(intent.uploadUrl, {
          method: "PUT", mode: "cors", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal,
          headers: { Authorization: `Bearer ${intent.uploadToken}`, "Content-Type": file.type },
          body: file
        });
      } catch (error) {
        if (signal.aborted) throw abortError();
        throw error;
      }
      if (response.status === 413) { await response.body?.cancel(); return { status: "rejected", reason: "size" }; }
      if (response.status === 415) { await response.body?.cancel(); return { status: "rejected", reason: "type" }; }
      if (response.status !== 201 || !jsonMedia(response)) { await response.body?.cancel(); throw new KamakuraCmsRequestError(response.status, null); }
      const uploaded = parseKamakuraCmsUploadResult(await response.json() as unknown);
      return { status: "uploaded", url: uploaded.url, width: uploaded.width, height: uploaded.height };
    },

    imageUrl(url, width) {
      // 公開画像の置き場の画像だけを Cloudflare の画像変換で縮める。ほかの URL はそのまま。
      if (!Number.isFinite(width) || width <= 0) return url;
      let parsed: URL;
      try { parsed = new URL(url); } catch { return url; }
      if (parsed.origin !== KAMAKURA_MEDIA_ORIGIN || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname.startsWith("/cdn-cgi/")) return url;
      const size = Math.min(4096, Math.max(16, Math.round(width)));
      return `${KAMAKURA_MEDIA_ORIGIN}/cdn-cgi/image/width=${size},format=auto${parsed.pathname}`;
    },

    previewUrl(_collectionId, item) {
      // 下書きのプレビューは無い。公開中（変更ありを含む）の項目だけ、公開中のページを開く。
      if (!siteOrigin || item.path === null || (item.status !== "published" && item.status !== "changed")) return null;
      if (!item.path.startsWith("/") || item.path.startsWith("//")) return null;
      try {
        const url = new URL(item.path, siteOrigin);
        return url.origin === siteOrigin ? url.href : null;
      } catch { return null; }
    }
  };
}
