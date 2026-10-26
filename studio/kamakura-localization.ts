import {
  isLocalizationItemKey, parseLocaleReleaseApplyResult, parseLocaleReleasePrepareResult, parseLocaleReleaseStateResult, parseLocalizationCatalogResult,
  parseLocalizationCommandResult, parseLocalizationImageResult, parseLocalizationItemResult, parseLocalizationJobResult, parseLocalizationListResult,
  parseLocalizationOverviewResult, parseLocalizationPreviewResult, parseLocalizationSettingsResult, parseLocalizationTranslationResult,
  type LocalizationImage, type LocalizationImageResult, type LocalizationWorkspaceAdapter, type LocalizationWorkspaceUnit
} from "../src/localization-workspace-model.js";
import {
  KAMAKURA_LOCALIZATION_BASE, KAMAKURA_LOCALIZATION_IMAGE_TYPES, KAMAKURA_LOCALIZATION_LIMITS,
  isKamakuraPublicImageUrl, kamakuraLocalizationCmsSource, parseKamakuraLocalizationUploadIntent, parseKamakuraLocalizationUploadRefusal
} from "./kamakura-localization-contract.js";

/**
 * 鎌倉サイトの翻訳を Studio の翻訳の画面（LocalizationWorkspace）で直す adapter。
 * 同一 origin の BFF（KAMAKURA_LOCALIZATION_BASE）だけを呼び、訳す言語の画像は upload intent の URL へ credentials なしで直接 PUT する。
 * 応答は本文に status があれば W1 の parser に通す（forbidden は 403・not_found は 404 でも本文は契約の形）。status の無い失敗は例外。
 */
export type KamakuraLocalizationAdapterOptions = {
  /** サイトの公開 URL の origin（Project の site.domains[0]）。"/" から始まる画像の表示用 URL を、この origin の絶対 URL にして出す。 */
  readonly siteOrigin?: string | null;
  /** 原文が CMS の項目のとき、Studio の CMS でその項目を開く URL（"/" から始まる同じサイトの path）。無ければ原文へのリンクを出さない。 */
  readonly cmsItemUrl?: (collectionId: string, itemId: string) => string | null;
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

const CURSOR = /^[A-Za-z0-9_-]{1,512}$/u;
const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const abortError = () => new DOMException("Aborted", "AbortError");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function supportId(body: unknown): string | null {
  const value = isRecord(body) ? body.supportId : undefined;
  return typeof value === "string" && /^[0-9a-f-]{36}$/u.test(value) ? value : null;
}

function jsonMedia(response: Response): boolean {
  return response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function call(method: "POST" | "PUT", path: string, body: unknown, signal: AbortSignal): Promise<Reply> {
  if (signal.aborted) throw abortError();
  let response: Response;
  try {
    response = await fetch(`${KAMAKURA_LOCALIZATION_BASE}/${path}`, {
      method, signal, cache: "no-store", credentials: "same-origin", redirect: "error",
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

/** 本文に status があれば契約の結果（parser へ）。BFF が所属を拒んだ 403 は forbidden。ほかは例外。 */
function settle<T>(reply: Reply, parse: (value: unknown) => T): T {
  if (isRecord(reply.body) && Object.hasOwn(reply.body, "status")) return parse(reply.body);
  if (reply.status === 403) return parse({ status: "forbidden" });
  throw new KamakuraLocalizationRequestError(reply.status, supportId(reply.body));
}

function itemPath(itemKey: string, action?: "command" | "translate"): string {
  if (!isLocalizationItemKey(itemKey)) throw new Error("翻訳の 1 件の指定が正しくありません。");
  return `items/${itemKey}${action === undefined ? "" : `/${action}`}`;
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

export function createKamakuraLocalizationAdapter(options: KamakuraLocalizationAdapterOptions = {}): LocalizationWorkspaceAdapter {
  const { cmsItemUrl, chooseImage } = options;
  const siteOrigin = httpsOrigin(options.siteOrigin);
  // 画像の表示用の URL が "/" から始まる（サイトの中の画像）なら、Studio の origin ではなくサイトの公開 origin から読む。
  // set-image で送る asset はそのまま（鎌倉の Worker の値）
  const absolute = (image: LocalizationImage): LocalizationImage => siteOrigin && image.url.startsWith("/") ? { ...image, url: `${siteOrigin}${image.url}` } : image;
  const displayable = (unit: LocalizationWorkspaceUnit): LocalizationWorkspaceUnit => unit.kind === "image" ? { ...unit, source: absolute(unit.source), value: unit.value && absolute(unit.value) } : unit;
  const adapter: LocalizationWorkspaceAdapter = {
    async loadOverview(signal) {
      return settle(await call("POST", "overview", {}, signal), parseLocalizationOverviewResult);
    },

    async listItems({ cursor }, signal) {
      if (cursor !== null && !CURSOR.test(cursor)) throw new Error("一覧の続きの指定が正しくありません。");
      return settle(await call("POST", cursor === null ? "items" : `items/after/${cursor}`, {}, signal), parseLocalizationListResult);
    },

    async loadItem({ itemKey }, signal) {
      const result = settle(await call("POST", itemPath(itemKey), {}, signal), (value) => parseLocalizationItemResult(value, itemKey));
      return result.status === "ready" ? { ...result, item: { ...result.item, units: result.item.units.map(displayable) } } : result;
    },

    async command(input, signal) {
      const result = settle(await call("POST", itemPath(input.itemKey, "command"), input, signal),
        (value) => parseLocalizationCommandResult(value, { itemKey: input.itemKey, unitId: input.unitId }));
      return result.status === "applied" || result.status === "conflict" ? { ...result, unit: displayable(result.unit) } : result;
    },

    async requestTranslation({ itemKey, operationId, unitIds }, signal) {
      return settle(await call("POST", itemPath(itemKey, "translate"), { itemKey, operationId, unitIds }, signal), parseLocalizationTranslationResult);
    },

    async readJob({ jobId }, signal) {
      if (!JOB_ID.test(jobId)) throw new Error("翻訳の依頼の指定が正しくありません。");
      return settle(await call("POST", `jobs/${jobId}`, {}, signal), (value) => parseLocalizationJobResult(value, jobId));
    },

    async advanceCatalog(_input, signal) {
      return settle(await call("POST", "catalog/advance", {}, signal), parseLocalizationCatalogResult);
    },

    async loadPreview({ itemKey, previewId, cursor }, signal) {
      return settle(await call("POST", "preview/items", { itemKey, previewId, cursor }, signal), parseLocalizationPreviewResult);
    },

    async readRelease(signal) {
      return settle(await call("POST", "release", {}, signal), parseLocaleReleaseStateResult);
    },

    async prepareRelease(input, signal) {
      const { operation, releaseId, expectedVersion, expectedCurrentVersion, resumeToken } = input;
      return settle(await call("POST", "release/prepare", { operation, releaseId, expectedVersion, expectedCurrentVersion, resumeToken }, signal),
        (value) => parseLocaleReleasePrepareResult(value, input));
    },

    async applyRelease({ confirmationToken, resumeToken }, signal) {
      // 反映した版は画面が準備の結果と比べる（ここでは形だけ）
      return settle(await call("POST", "release/apply", { confirmationToken, resumeToken }, signal), (value) => parseLocaleReleaseApplyResult(value, { prepared: null }));
    },

    async saveSettings({ expectedVersion, autoDraft }, signal) {
      return settle(await call("PUT", "settings", { expectedVersion, autoDraft }, signal), parseLocalizationSettingsResult);
    },

    async uploadImage({ itemKey, unitId, file }, signal) {
      if (!KAMAKURA_LOCALIZATION_IMAGE_TYPES.has(file.type)) return rejected("type");
      if (file.size < 1 || !isLocalizationItemKey(itemKey)) return rejected("invalid");
      if (file.size > KAMAKURA_LOCALIZATION_LIMITS.imageBytes) return rejected("size");
      const reply = await call("POST", "uploads/intent", { itemKey, unitId, name: uploadName(file.name), mimeType: file.type, bytes: file.size }, signal);
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
  return adapter;
}
