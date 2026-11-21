import {
  createOperationId, isLocalizationItemKey, parseLocalizationImageResult,
  type LocalizationImage, type LocalizationImageResult, type LocalizationWorkspaceAdapter, type LocalizationWorkspaceUnit
} from "../src/localization-workspace-model.js";
import { createPageEditingApiClient, EditingApiClientError, type EditingLocalizationInput, type EditingLocalizationOperationId } from "../src/editing-client.js";
import { KAMAKURA_CMS_SITE_ID, KAMAKURA_EDITING_API_BASE } from "./kamakura-cms-contract.js";
import {
  KAMAKURA_LOCALIZATION_BASE, KAMAKURA_LOCALIZATION_IMAGE_TYPES, KAMAKURA_LOCALIZATION_LIMITS,
  isKamakuraPublicImageUrl, kamakuraLocalizationCmsSource, kamakuraLocalizationPage, parseKamakuraLocalizationUploadIntent, parseKamakuraLocalizationUploadRefusal
} from "./kamakura-localization-contract.js";

/**
 * 鎌倉サイトの翻訳を Studio の翻訳の画面（LocalizationWorkspace）で直す adapter。
 * 共通 Editing API は Studio と同じ origin の BFF を経由する。公開画像のアップロードはホストの既存契約を使う。
 */
export type KamakuraLocalizationAdapterOptions = {
  /** 同一 origin の Editing API BFF に使う Studio の origin。 */
  readonly studioOrigin: string;
  /** サイトの公開 URL の origin（Project の site.domains[0]）。"/" から始まる画像の表示用 URL を、この origin の絶対 URL にして出す。 */
  readonly siteOrigin?: string | null;
  /** 原文が CMS の項目のとき、Studio の CMS でその項目を開く URL（"/" から始まる同じサイトの path）。無ければ原文へのリンクを出さない。 */
  readonly cmsItemUrl?: (collectionId: string, itemId: string) => string | null;
  /** CMS の項目の English タブを直接開く Studio 内 URL。無ければ一覧の項目画面を使う。 */
  readonly cmsTranslationUrl?: (collectionId: string, itemId: string) => string | null;
  /** 共通ページの English キャンバスを直接開く Studio 内 URL。 */
  readonly pageTranslationUrl?: (pageId: string) => string | null;
  /** 素材から画像を選ぶホストの画面。選んだ鎌倉の公開画像の URL、やめたら null。無ければ「素材から選ぶ」を出さない。 */
  readonly chooseImage?: (input: { readonly itemKey: string; readonly unitId: string }, signal: AbortSignal) => Promise<string | null>;
};

/** BFF・アップロード先の失敗。message に内部の詳細を入れない。supportId は BFF が返したときだけ。 */
export class KamakuraLocalizationRequestError extends Error {
  constructor(readonly status: number, readonly supportId: string | null) {
    super("Kamakura localization request failed");
    this.name = "KamakuraLocalizationRequestError";
  }
}

type Reply = { readonly status: number; readonly body: unknown };

const abortError = () => new DOMException("Aborted", "AbortError");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function supportId(body: unknown): string | null {
  const value = isRecord(body) ? body.supportId : undefined;
  return typeof value === "string" && /^[0-9a-f-]{36}$/u.test(value) ? value : null;
}

function jsonMedia(response: Response): boolean {
  return response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function uploadIntent(body: unknown, signal: AbortSignal): Promise<Reply> {
  if (signal.aborted) throw abortError();
  let response: Response;
  try {
    response = await fetch(`${KAMAKURA_LOCALIZATION_BASE}/uploads/intent`, {
      method: "POST", signal, cache: "no-store", credentials: "same-origin", redirect: "error",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (error) {
    if (signal.aborted) throw abortError();
    throw error;
  }
  if (!jsonMedia(response)) { await response.body?.cancel(); throw new KamakuraLocalizationRequestError(response.status, null); }
  try { return { status: response.status, body: await response.json() as unknown }; }
  catch {
    if (signal.aborted) throw abortError();
    throw new KamakuraLocalizationRequestError(response.status, null);
  }
}

/** ファイル名を BFF の条件（1〜200 字・制御文字なし）に収める。 */
function uploadName(name: string): string {
  let result = "";
  for (const character of name.replace(/[\u0000-\u001f\u007f]/gu, "").trim()) {
    if (result.length + character.length > KAMAKURA_LOCALIZATION_LIMITS.uploadNameLength) break;
    result += character;
  }
  return result.trim() || "image";
}

const rejected = (reason: "type" | "size" | "permission" | "invalid"): LocalizationImageResult => ({ status: "rejected", reason });

function httpsOrigin(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && (url.pathname === "/" || url.pathname === "") ? url.origin : null;
  } catch { return null; }
}

export function createKamakuraLocalizationAdapter(options: KamakuraLocalizationAdapterOptions): LocalizationWorkspaceAdapter {
  const { cmsItemUrl, cmsTranslationUrl, pageTranslationUrl, chooseImage } = options;
  const siteOrigin = httpsOrigin(options.siteOrigin);
  const client = createPageEditingApiClient({ origin: options.studioOrigin, siteId: KAMAKURA_CMS_SITE_ID, basePath: KAMAKURA_EDITING_API_BASE });
  const execute = async <Id extends EditingLocalizationOperationId>(id: Id, input: EditingLocalizationInput<Id>, signal: AbortSignal, itemOperation = false) => {
    if (signal.aborted) throw abortError();
    try { return await client.executeLocalization(id, input, signal); }
    catch (error) {
      if (error instanceof EditingApiClientError) {
        if (error.code === "forbidden") return { status: "forbidden" } as const;
        if (itemOperation && error.code === "not_found") return { status: "not_found" } as const;
      }
      throw error;
    }
  };
  const loadOverview = (signal: AbortSignal) => execute("localization.overview", {}, signal);
  // 画像の表示用の URL が "/" から始まる（サイトの中の画像）なら、Studio の origin ではなくサイトの公開 origin から読む。
  // set-image で送る asset はそのまま（鎌倉の Worker の値）
  const absolute = (image: LocalizationImage): LocalizationImage => siteOrigin && image.url.startsWith("/") ? { ...image, url: `${siteOrigin}${image.url}` } : image;
  const displayable = (unit: LocalizationWorkspaceUnit): LocalizationWorkspaceUnit => unit.kind === "image" ? { ...unit, source: absolute(unit.source), value: unit.value && absolute(unit.value) } : unit;
  const adapter: LocalizationWorkspaceAdapter = {
    loadOverview,

    async listItems({ cursor }, signal) {
      return execute("localization.items.list", { cursor }, signal);
    },

    async loadItem({ itemKey }, signal) {
      const result = await execute("localization.items.read", { itemKey }, signal, true);
      return result.status === "ready" ? { ...result, item: { ...result.item, units: result.item.units.map(displayable) } } : result;
    },

    async command(input, signal) {
      const result = await execute("localization.items.command", input, signal, true);
      return result.status === "applied" || result.status === "conflict" ? { ...result, unit: displayable(result.unit) } : result;
    },

    async requestTranslation({ itemKey, operationId, unitIds }, signal) {
      const result = await loadOverview(signal);
      if (result.status !== "ready") return result;
      const translated = await execute("localization.items.translate", { itemKey, operationId, unitIds, expectedVersion: result.overview.version }, signal, true);
      return translated.status === "conflict" ? { status: "invalid", message: "原文または訳文の状態が変わりました。もう一度翻訳を依頼してください。" } : translated;
    },

    async readJob({ jobId }, signal) {
      return execute("localization.jobs.read", { jobId }, signal, true);
    },

    async advanceCatalog(_input, signal) {
      const result = await loadOverview(signal);
      if (result.status !== "ready") return result;
      const { catalog, permissions, version } = result.overview;
      if (catalog.state === "current") return { status: "current" };
      const updating = { status: "updating", progress: catalog.progress };
      if (!permissions.includes("edit")) return updating;
      const advanced = await execute("localization.catalog.advance", { expectedVersion: version, operationId: createOperationId() }, signal);
      return advanced.status === "conflict" ? updating : advanced;
    },

    async loadPreview({ itemKey, previewId, cursor }, signal) {
      return execute("localization.preview", { itemKey, previewId, cursor }, signal, true);
    },

    async readRelease(signal) {
      return execute("localization.release.read", {}, signal);
    },

    async prepareRelease({ resumeToken, ...input }, signal, operationId) {
      return execute("localization.release.prepare", resumeToken === null
        ? { ...input, resumeToken, operationId: operationId ?? createOperationId() }
        : { ...input, resumeToken }, signal);
    },

    async applyRelease(input, signal, { operation, expectedVersion, prepared }) {
      return execute("localization.release.apply", { ...input, operation, expectedVersion,
        ...(prepared ? { prepared: { releaseId: prepared.releaseId, version: prepared.version } } : {}) }, signal);
    },

    async saveSettings(input, signal) {
      return execute("localization.settings.save", { ...input, operationId: createOperationId() }, signal);
    },

    async uploadImage({ itemKey, unitId, file }, signal) {
      if (!KAMAKURA_LOCALIZATION_IMAGE_TYPES.has(file.type)) return rejected("type");
      if (file.size < 1 || !isLocalizationItemKey(itemKey)) return rejected("invalid");
      if (file.size > KAMAKURA_LOCALIZATION_LIMITS.imageBytes) return rejected("size");
      const reply = await uploadIntent({ itemKey, unitId, name: uploadName(file.name), mimeType: file.type, bytes: file.size }, signal);
      if (reply.status !== 201) {
        // 契約の結果（権限が無い・項目が無い・画像の項目ではない）と、BFF・鎌倉の Worker の拒否
        if (isRecord(reply.body) && Object.hasOwn(reply.body, "status")) return rejected(parseKamakuraLocalizationUploadRefusal(reply.body).status === "forbidden" ? "permission" : "invalid");
        if (reply.status === 403) return rejected("permission");
        if (reply.status === 413) return rejected("size");
        if (reply.status === 415) return rejected("type");
        if (reply.status === 400) return rejected("invalid");
        throw new KamakuraLocalizationRequestError(reply.status, supportId(reply.body));
      }
      // 行き先は鎌倉の Worker の /internal/studio/localization-upload/<uploadId> だけ（parser が origin とパスを確かめる）
      const intent = parseKamakuraLocalizationUploadIntent(reply.body);
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
      if (response.status === 413) { await response.body?.cancel(); return rejected("size"); }
      if (response.status === 415) { await response.body?.cancel(); return rejected("type"); }
      if (response.status !== 201 || !jsonMedia(response)) { await response.body?.cancel(); throw new KamakuraLocalizationRequestError(response.status, null); }
      const uploaded = parseLocalizationImageResult(await response.json() as unknown);
      if (uploaded.status !== "uploaded" || uploaded.image.asset.kind !== "image-url") throw new KamakuraLocalizationRequestError(response.status, null);
      return uploaded;
    }
  };
  if (chooseImage) {
    // 鎌倉の Worker が set-image で受けるのは公開画像の URL（{ kind: "image-url", src }）だけ
    adapter.pickAsset = async (input, signal) => {
      const src = await chooseImage(input, signal);
      if (signal.aborted) throw abortError();
      if (src === null) return { status: "cancelled" };
      if (!isKamakuraPublicImageUrl(src)) return rejected("invalid");
      return parseLocalizationImageResult({ status: "picked", image: { asset: { kind: "image-url", src }, url: src } });
    };
  }
  if (cmsItemUrl) {
    // CMS の項目の原文は Studio の CMS で開く。固定ページ・共通部分などの原文はコードで管理しているので出さない
    adapter.sourceLink = (itemKey) => {
      const source = kamakuraLocalizationCmsSource(itemKey);
      return source ? cmsItemUrl(source.collectionId, source.itemId) : null;
    };
  }
  if (cmsTranslationUrl || pageTranslationUrl) {
    adapter.editLink = (itemKey) => {
      const source = kamakuraLocalizationCmsSource(itemKey);
      if (source) return cmsTranslationUrl?.(source.collectionId, source.itemId) ?? null;
      const pageId = kamakuraLocalizationPage(itemKey);
      return pageId ? pageTranslationUrl?.(pageId) ?? null : null;
    };
  }
  return adapter;
}
