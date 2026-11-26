import { useEffect, useMemo, useRef, useState } from "react";
import { StudioPageEditor } from "./editor-performance.js";
import { createExternalFramePolicy } from "../src/react.js";
import { createProjectEditorAdapter } from "../src/project-editor-adapter.js";
import type { EditorAdapter, EditorPage, EditorPageChange, EditorPageChangePlan, EditorBreakpoint, EditorBreakpointSettingsSnapshot, EditorLocalizedPage, EditorLocalizationCommandResult, EditorLocalizationPageSnapshot, EditorLocalizationSiteSnapshot, EditorReleasePlan, EditorReleaseRequest, EditorSaveResult, EditorSnapshot, EditorTarget } from "../src/editor-types.js";
import type { Project } from "../src/projects.js";
import { studioBuilderDefinition } from "./integration-builder.js";
import { projectRoutePath } from "./project-routes.mjs";
import { createKamakuraAssetLibrary } from "./kamakura-assets.js";
import { createKamakuraEditorBlocks } from "./kamakura-editor-blocks.js";
import { createBlankEmbedRegistry, parsePageDocument, type BlockContracts } from "../src/core.js";
import { parseLocalizationOverlay, parseSiteLocalizationConfig } from "../src/localization.js";
import { KAMAKURA_CATALOG_CONTRACT_ERROR_CODE, KAMAKURA_CATALOG_CONTRACT_ERROR_STATUS, KAMAKURA_COMMON_PAGE_ID as COMMON_PAGE_ID, KAMAKURA_EDITOR_SITE_ID, KAMAKURA_ORIGIN_RETAINING_FRAME_SOURCES, KamakuraCatalogContractError, parseKamakuraCatalog, parseKamakuraCatalogPage } from "./kamakura-catalog.js";
import type { KamakuraCatalog } from "./kamakura-catalog.js";
import { parseEnglishPublicationAccepted } from "../src/english-publication.js";
import { normalizePageChange, validatePageChangePlan } from "../src/editor-model.js";
import { createEditingApiSiteSettingsFacade, createPageEditingApiClient, EditingApiClientError, supportsPageNodeNames } from "../src/editing-client.js";
import type { EditingPageReleaseSetItem } from "../src/editing-api.js";

const BASE = "/api/projects/project-kamakura/sites/kamakura/editor";
const LOCALIZATION_BASE = "/api/projects/project-kamakura/sites/kamakura/localization";
const X_POST_FRAME_URL = "https://kamakura-media.niho.life/niho-web/embeds/v1/x-post-frame-v1.html";
// kamakura-site が見た目の編集を凍結している間の保存・公開の 409。競合とは分けて案内する（kamakura-site#84）。
const VISUAL_EDITOR_FROZEN = "visual_editor_frozen";
const FROZEN_MESSAGE = "サイトの見た目の編集は凍結中です。表示の確認だけでき、保存と公開はできません。";
const KAMAKURA_BREAKPOINTS: readonly EditorBreakpoint[] = [
  { minWidth: 691, label: "タブレット", previewWidth: 840 },
  { minWidth: 991, label: "スモール", previewWidth: 991 },
  { minWidth: 1280, label: "PC", previewWidth: 1280 }
];
const CONFIRMATION_TOKEN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}){2}$/u;
type RequestMethod = "GET" | "POST" | "PUT";
type EditorApiStatus = { readonly status: number; readonly errorCode: string | null; readonly supportId: string | null };
type CatalogState = { readonly status: "loading" } | { readonly status: "error"; readonly code: number; readonly errorCode: string | null; readonly supportId: string | null }
  | { readonly status: "ready"; readonly value: KamakuraCatalog; readonly reads: KamakuraSiteReads };
type KamakuraSiteReads = {
  readonly localization: Promise<unknown>;
  readonly breakpoints: Promise<EditorBreakpointSettingsSnapshot>;
};
export type KamakuraEditorLoad = {
  readonly catalog: Promise<KamakuraCatalog>;
  readonly reads: KamakuraSiteReads;
  abort(): void;
};

class EditorApiError extends Error {
  constructor(readonly status: number, readonly code: string | null = null, readonly supportId: string | null = null, message?: string) {
    super(message ?? (code === KAMAKURA_CATALOG_CONTRACT_ERROR_CODE ? "Kamakura catalog contract mismatch" : code === VISUAL_EDITOR_FROZEN ? FROZEN_MESSAGE : status === 401 ? "Cloudflare Access のセッションを確認してください。" : status === 403 ? "このプロジェクトの編集権限がありません。" : status === 404 ? "新形式のページが見つかりません。" : status === 503 ? "編集ブリッジを利用できません。" : "編集 API の要求を完了できませんでした。"));
  }
}

class EditorContentUnavailableError extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("編集 API の応答が正しくありません。");
  return value as Record<string, unknown>;
}

function readSupportId(value: unknown): string | null {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) return null;
  return value;
}

function validVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validTarget(target: EditorTarget): EditorTarget {
  if (target.siteId !== KAMAKURA_EDITOR_SITE_ID || target.locale !== "ja" || !COMMON_PAGE_ID.test(target.pageId)) throw new Error("新形式の編集対象ではありません。");
  return { siteId: "kamakura", pageId: target.pageId, locale: "ja" };
}

function validEnglishTarget(target: EditorTarget): EditorTarget {
  if (target.siteId !== KAMAKURA_EDITOR_SITE_ID || target.locale !== "en" || !COMMON_PAGE_ID.test(target.pageId)) throw new Error("英語の編集対象ではありません。");
  return { siteId: KAMAKURA_EDITOR_SITE_ID, pageId: target.pageId, locale: "en" };
}

function pagePath(target: EditorTarget): string {
  return `${BASE}/${validTarget(target).pageId}`;
}

function localizationPagePath(target: EditorTarget): string {
  return `${LOCALIZATION_BASE}/editor/pages/${validEnglishTarget(target).pageId}`;
}

type ApiResult = { readonly value: unknown; readonly etag: string | null; readonly notModified: boolean };

async function apiResult(path: string, method: RequestMethod, body: Record<string, unknown> | undefined, signal: AbortSignal, ifNoneMatch?: string): Promise<ApiResult> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const pagePath = path.startsWith(`${BASE}/`) ? path.slice(BASE.length + 1) : "";
  const revalidateRead = method === "GET" && pagePath === "catalog";
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      signal,
      cache: revalidateRead ? "no-cache" : "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...(ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  } catch (error) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    throw error;
  }
  const etag = response.headers.get("ETag");
  if (response.status === 304) return { value: null, etag, notModified: true };
  if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw new EditorApiError(503);
  const value = await response.json() as unknown;
  if (!response.ok) {
    const errorObject = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
    const errorCode = errorObject && typeof errorObject.error === "string"
      ? errorObject.error
      : null;
    throw new EditorApiError(response.status, errorCode, readSupportId(errorObject?.supportId));
  }
  return { value, etag, notModified: false };
}

async function api(path: string, method: RequestMethod, body: Record<string, unknown> | undefined, signal: AbortSignal): Promise<unknown> {
  const result = await apiResult(path, method, body, signal);
  if (result.notModified) throw new EditorApiError(503);
  return result.value;
}

export function loadKamakuraEditorCatalog(signal: AbortSignal): Promise<KamakuraCatalog> {
  return api(`${BASE}/catalog`, "GET", undefined, signal).then(parseKamakuraCatalog);
}

type CatalogCache = { readonly etag: string; readonly value: KamakuraCatalog };

async function loadCachedKamakuraEditorCatalog(signal: AbortSignal, cache: { current: CatalogCache | null }): Promise<KamakuraCatalog> {
  const path = `${BASE}/catalog`;
  let result = await apiResult(path, "GET", undefined, signal, cache.current?.etag);
  if (result.notModified && cache.current && result.etag === cache.current.etag) return structuredClone(cache.current.value);
  if (result.notModified) result = await apiResult(path, "GET", undefined, signal);
  if (result.notModified) throw new EditorApiError(503);
  const value = parseKamakuraCatalog(result.value);
  cache.current = result.etag ? { etag: result.etag, value: structuredClone(value) } : null;
  return value;
}

export function loadKamakuraEditor(controller: AbortController, origin: string, catalog?: Promise<KamakuraCatalog>, catalogCache?: { current: CatalogCache | null }): KamakuraEditorLoad {
  const { signal } = controller;
  const catalogRequest = catalog ?? (catalogCache ? loadCachedKamakuraEditorCatalog(signal, catalogCache) : loadKamakuraEditorCatalog(signal));
  const localization = api(`${LOCALIZATION_BASE}/editor/site`, "POST", {}, signal);
  const breakpoints = createPageEditingApiClient({ origin, siteId: KAMAKURA_EDITOR_SITE_ID, basePath: `${BASE}/editing-api/v1` }).readBreakpointSettings(signal);
  // The consumers handle each error when they mount, independently of the catalog.
  void localization.catch(() => {});
  void breakpoints.catch(() => {});
  return { catalog: catalogRequest, reads: { localization, breakpoints }, abort: () => controller.abort() };
}

function statusFromError(error: unknown): EditorApiStatus {
  if (error instanceof EditorApiError) return { status: error.status, errorCode: error.code, supportId: error.supportId };
  if (error instanceof KamakuraCatalogContractError) return { status: KAMAKURA_CATALOG_CONTRACT_ERROR_STATUS, errorCode: KAMAKURA_CATALOG_CONTRACT_ERROR_CODE, supportId: null };
  return { status: 503, errorCode: null, supportId: null };
}

function safeLine(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}

function localizationVersion(value: unknown, prefix: "l" | "p" | "s"): value is string {
  return typeof value === "string" && new RegExp(`^${prefix}\\.[0-9a-f]{64}$`, "u").test(value);
}

function parseLocalizationSite(value: unknown, catalog: KamakuraCatalog): EditorLocalizationSiteSnapshot {
  const source = record(value);
  if (source.status !== "ready" || Object.keys(source).sort().join(",") !== "config,pages,status,version" || !localizationVersion(source.version, "s") || !Array.isArray(source.pages) || source.pages.length > 500) {
    throw new Error("言語設定とページ一覧の応答が正しくありません。");
  }
  const config = parseSiteLocalizationConfig(source.config);
  if (config.siteId !== KAMAKURA_EDITOR_SITE_ID || config.sourceLocale !== "ja" || config.enabledLocales.length !== 2 || !config.enabledLocales.includes("ja") || !config.enabledLocales.includes("en")) {
    throw new Error("言語設定の対象が一致しません。");
  }
  const ids = new Set<string>();
  const pages = source.pages.map((input): EditorLocalizedPage => {
    const page = record(input), allowed = ["siteId", "pageId", "title", "path", "kind", "locales"];
    if (Object.keys(page).some((key) => !allowed.includes(key)) || page.siteId !== KAMAKURA_EDITOR_SITE_ID || typeof page.pageId !== "string" || !COMMON_PAGE_ID.test(page.pageId)
      || ids.has(page.pageId) || !safeLine(page.title, 300) || page.path !== undefined && (typeof page.path !== "string" || page.path.length > 160 || /[\u0000-\u001f\u007f]/u.test(page.path))
      || page.kind !== undefined && !["page", "template", "shared"].includes(String(page.kind))) throw new Error("言語別ページ一覧が正しくありません。");
    const locales = record(page.locales), ja = record(locales.ja), en = record(locales.en);
    if (Object.keys(locales).sort().join(",") !== "en,ja" || Object.keys(ja).join(",") !== "state" || ja.state !== "source"
      || Object.keys(en).some((key) => !["state", "changed", "published"].includes(key)) || !["missing", "translating", "review-needed", "reviewed", "failed"].includes(String(en.state))
      || en.changed !== undefined && (!Number.isSafeInteger(en.changed) || (en.changed as number) < 0) || en.published !== undefined && typeof en.published !== "boolean") {
      throw new Error("言語別ページの状態が正しくありません。");
    }
    const sourcePage = catalog.pages.find((entry) => entry.pageId === page.pageId);
    if (!sourcePage) throw new Error("言語別ページ一覧に日本語の正本ページがありません。");
    ids.add(page.pageId);
    return { siteId: KAMAKURA_EDITOR_SITE_ID, pageId: page.pageId, title: sourcePage.title, locales: { ja: { state: "source" }, en: { state: en.state as "missing" | "translating" | "review-needed" | "reviewed" | "failed", ...(en.changed === undefined ? {} : { changed: en.changed as number }), ...(en.published === undefined ? {} : { published: en.published }) } },
      ...(sourcePage.path === undefined ? {} : { path: sourcePage.path }), ...(sourcePage.kind === undefined ? {} : { kind: sourcePage.kind }) };
  });
  if (ids.size !== catalog.pages.length || catalog.pages.some((page) => !ids.has(page.pageId))) throw new Error("日本語と英語のページ一覧が一致しません。");
  return { config, pages, version: source.version };
}

function parseLocalizationPage(value: unknown, target: EditorTarget, blocks: BlockContracts): EditorLocalizationPageSnapshot {
  const source = record(value), checked = validEnglishTarget(target);
  if (source.status !== "ready" || Object.keys(source).sort().join(",") !== "overlay,sourceDocument,sourceVersion,status,version"
    || !localizationVersion(source.sourceVersion, "p") || !localizationVersion(source.version, "l")) throw new Error("翻訳状態の応答が正しくありません。");
  const document = parsePageDocument(source.sourceDocument, blocks);
  if (document.siteId !== checked.siteId || document.pageId !== checked.pageId || !["ja", "ja-JP"].includes(document.locale)) throw new Error("翻訳原文の対象が一致しません。");
  const overlay = parseLocalizationOverlay(source.overlay);
  if (overlay.siteId !== checked.siteId || overlay.pageId !== checked.pageId || overlay.sourceLocale !== "ja" || overlay.targetLocale !== "en") throw new Error("翻訳下書きの対象が一致しません。");
  return { sourceDocument: document, sourceVersion: source.sourceVersion, overlay, version: source.version };
}

function parseLocalizationCommandResult(value: unknown): EditorLocalizationCommandResult {
  const source = record(value);
  if (source.status === "conflict" && Object.keys(source).length === 1) return { status: "conflict" };
  if (source.status === "invalid" && Object.keys(source).sort().join(",") === "message,status" && safeLine(source.message, 1000)) throw new Error(source.message);
  if (source.status !== "applied" || Object.keys(source).sort().join(",") !== "status,version" || !localizationVersion(source.version, "l")) throw new Error("翻訳操作の結果が正しくありません。");
  return { status: "applied", version: source.version };
}

function parseLocalizedSave(value: unknown): EditorSaveResult {
  const source = record(value);
  if (source.status === "conflict" && Object.keys(source).length === 1) return { status: "conflict" };
  if (source.status === "invalid" && Object.keys(source).sort().join(",") === "message,status" && safeLine(source.message, 1000)) throw new Error(source.message);
  if (source.status !== "saved" || Object.keys(source).sort().join(",") !== "revision,status,version" || !localizationVersion(source.version, "l")) throw new Error("英語下書き保存の結果が正しくありません。");
  return parseSaved(source);
}

function parseSaved(value: unknown): Extract<EditorSaveResult, { status: "saved" }> {
  const source = record(value);
  if (source.status !== "saved" || !validVersion(source.version) || !Number.isSafeInteger(source.revision) || (source.revision as number) < 1) throw new Error("下書き保存の結果が正しくありません。");
  return { status: "saved", version: source.version, revision: source.revision as number };
}

function releaseMatches(plan: EditorReleasePlan, request: EditorReleaseRequest, domain: string): boolean {
  let target: EditorTarget;
  try { target = validTarget(plan.target); validTarget(request.target); }
  catch { return false; }
  if (target.siteId !== request.target.siteId || target.pageId !== request.target.pageId || target.locale !== request.target.locale || !validVersion(plan.expectedVersion) || plan.expectedVersion !== request.expectedVersion || !validVersion(plan.presentationVersion) || plan.presentationVersion !== request.presentationVersion || plan.action !== request.action || plan.revision !== request.revision || plan.domain !== domain) return false;
  if (plan.action === "publish" ? plan.revision !== undefined : plan.action !== "rollback" || !Number.isSafeInteger(plan.revision) || plan.revision! <= 0) return false;
  if (typeof plan.confirmationToken !== "string" || !CONFIRMATION_TOKEN.test(plan.confirmationToken) || !Array.isArray(plan.changes) || plan.changes.length > 81) return false;
  return plan.changes.every((change) => !!change && typeof change.path === "string" && change.path.length <= 512 && typeof change.before === "string" && change.before.length <= 1_200 && typeof change.after === "string" && change.after.length <= 1_200);
}

function parsePlan(value: unknown, request: EditorReleaseRequest, domain: string): EditorReleasePlan {
  const plan = structuredClone(value) as EditorReleasePlan;
  if (!releaseMatches(plan, request, domain)) throw new Error("公開確認の対象・版・操作・ドメインが一致しません。再度確認してください。");
  return plan;
}

function samePageManagementEntries(listed: readonly EditorPage[], current: readonly EditorPage[]): boolean {
  if (listed.length !== current.length) return false;
  const key = (page: EditorPage) => `${page.siteId}\u0000${page.pageId}\u0000${page.locale}`;
  const byTarget = new Map(current.map((page) => [key(page), page]));
  return listed.every((page) => {
    const entry = byTarget.get(key(page));
    if (!entry) return false;
    return entry.kind === page.kind && entry.title === page.title && entry.path === page.path
      && entry.visibility === page.visibility && entry.published === page.published;
  });
}

export function createKamakuraAdapter(catalog: KamakuraCatalog, onStatus: (status: EditorApiStatus | null) => void, origin = "https://studio.niho.life", initialReads?: KamakuraSiteReads): EditorAdapter {
  const editingApi = createPageEditingApiClient({ origin, siteId: KAMAKURA_EDITOR_SITE_ID, basePath: `${BASE}/editing-api/v1`, editorSnapshot: { blocks: catalog.blockContracts } });
  const site = catalog.sites.find(({ id }) => id === KAMAKURA_EDITOR_SITE_ID);
  if (!site) throw new Error("鎌倉サイトの設定がありません。");
  const siteSettings = createEditingApiSiteSettingsFacade(editingApi, KAMAKURA_EDITOR_SITE_ID, { title: site.name, locale: "ja" });
  const siteSettingsReads = new Map<string, Promise<Awaited<ReturnType<NonNullable<typeof siteSettings.readSiteSettings>>>>>();
  const readSiteSettings = (siteId: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    let pending = siteSettingsReads.get(siteId);
    if (!pending) {
      pending = siteSettings.readSiteSettings!(siteId, new AbortController().signal);
      siteSettingsReads.set(siteId, pending);
      void pending.finally(() => {
        if (siteSettingsReads.get(siteId) === pending) siteSettingsReads.delete(siteId);
      }).catch(() => {});
    }
    return pending.then((snapshot) => {
      signal.throwIfAborted();
      return snapshot;
    });
  };
  let currentCatalog = catalog, initialPages = true;
  let localizationRead = initialReads?.localization, breakpointRead = initialReads?.breakpoints;
  const releaseOperationIds = new Map<string, string>();
  async function request<T>(signal: AbortSignal, run: () => Promise<T>, reportStatus = true): Promise<T> {
    try {
      signal.throwIfAborted();
      const result = await run();
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (reportStatus) onStatus(null);
      return result;
    } catch (error) {
      const normalized = error instanceof EditingApiClientError ? new EditorApiError(error.status ?? 503, error.code) : error;
      if (reportStatus && !signal.aborted && normalized instanceof EditorApiError && (normalized.status !== 409 || normalized.code === VISUAL_EDITOR_FROZEN)) onStatus(statusFromError(normalized));
      else if (reportStatus && !signal.aborted && !(normalized instanceof EditorApiError) && !(normalized instanceof EditorContentUnavailableError)) onStatus(statusFromError(normalized));
      throw normalized;
    }
  }
  async function conflict<T>(run: () => Promise<T>): Promise<T | { status: "conflict" }> {
    try { return await run(); }
    catch (error) { if (error instanceof EditorApiError && error.status === 409 && error.code !== VISUAL_EDITOR_FROZEN) return { status: "conflict" }; throw error; }
  }
  function supportedPageChange(input: EditorPageChange) {
    const change = normalizePageChange(input);
    if (!change || change.action === "duplicate" || !catalog.pageChangeActions?.includes(change.action)) throw new Error("このページ操作は利用できません。");
    if (change.action === "create") {
      if (change.siteId !== KAMAKURA_EDITOR_SITE_ID || change.locale !== "ja") throw new Error("新形式の編集対象ではありません。");
    } else validTarget(change.target);
    return change;
  }
  async function readJapaneseDocument(target: EditorTarget, signal: AbortSignal): Promise<EditorSnapshot> {
    const checked = validTarget(target);
    const required = currentCatalog.nativePresentationPages.includes(checked.pageId);
    const wire = await editingApi.read(checked, signal);
    if (!wire.editorState) throw new EditorApiError(503, "editor_state_unavailable");
    if (required && wire.presentation === undefined) throw new Error("このサイトに必要な表示コンテキストがありません。");
    return { ...wire.editorState, document: wire.document, version: wire.version,
      ...(wire.stylesVersion === undefined ? {} : { stylesVersion: wire.stylesVersion }),
      ...(wire.draftStylesVersion === undefined ? {} : { draftStylesVersion: wire.draftStylesVersion }),
      ...(wire.presentation === undefined ? {} : { presentation: wire.presentation }) };
  }
  async function readEnglishDocument(target: EditorTarget, signal: AbortSignal): Promise<EditorSnapshot> {
    const wire = await editingApi.read(validEnglishTarget(target), signal);
    if (!wire.presentation) throw new Error("このページに必要な英語表示コンテキストがありません。");
    return { document: wire.document, version: wire.version, presentation: wire.presentation };
  }
  async function readPageDocument(target: EditorTarget, signal: AbortSignal): Promise<EditorSnapshot> {
    return target.locale === "en"
      ? readEnglishDocument(target, signal)
      : readJapaneseDocument(target, signal);
  }
  return {
    ...siteSettings,
    readSiteSettings,
    listSites: (signal) => request(signal, async () => catalog.sites),
    listPages: (siteId, signal) => request(signal, async () => {
      if (siteId !== "kamakura") throw new Error("編集対象のサイトがありません。");
      if (initialPages) initialPages = false;
      else {
        const latest = await loadKamakuraEditorCatalog(signal);
        signal.throwIfAborted();
        currentCatalog = latest;
      }
      return currentCatalog.pages;
    }),
    ...(catalog.pageChangeActions ? {
      pageChangeActions: catalog.pageChangeActions,
      pagePathEditable: catalog.pagePathEditable === true,
      preparePageChange: (input: EditorPageChange, signal: AbortSignal) => request(signal, async () => {
        const change = supportedPageChange(input);
        const { pages, version } = await editingApi.readPageCatalog(signal);
        if (!samePageManagementEntries(currentCatalog.pages, pages)) throw new EditorApiError(409, "version_conflict");
        return validatePageChangePlan(await editingApi.preparePageChange(change, version, signal), change, catalog.sites[0]!);
      }),
      applyPageChange: (input: EditorPageChangePlan, signal: AbortSignal) => conflict(() => request(signal, async () => {
        const change = supportedPageChange(input.change);
        const plan = validatePageChangePlan(input, change, catalog.sites[0]!);
        const result = await editingApi.applyPageChange(plan, signal);
        if (result.status !== "applied") throw new EditorApiError(409, "version_conflict");
        const page = parseKamakuraCatalogPage(result.page);
        const matchesChange = change.action === "create"
          ? page.title === change.title && page.path === change.path && page.published === false
          : page.pageId === change.target.pageId && (change.action === "visibility"
            ? page.visibility === change.visibility
            : page.title === change.title && page.path === change.path);
        if (page.kind !== "page" || !page.path || !matchesChange) throw new Error("ページ操作の結果が一致しません。");
        return { status: "applied" as const, page };
      }))
    } : {}),
    listFormCompletionPages: (target, signal) => request(signal, async () => {
      if (target.siteId !== KAMAKURA_EDITOR_SITE_ID || !COMMON_PAGE_ID.test(target.pageId) || !["ja", "en"].includes(target.locale)) throw new Error("完了ページの対象が正しくありません。");
      if (target.locale !== "ja") return [];
      return currentCatalog.pages.filter((page) => page.kind === "page" && page.path?.endsWith("-success") && page.pageId !== target.pageId && page.visibility !== "private" && page.published !== false)
        .map((page) => ({ ...page, visibility: "public" as const, published: true }));
    }),
    breakpointSettings: {
      read: (siteId, signal) => request(signal, async () => {
        if (siteId !== KAMAKURA_EDITOR_SITE_ID) throw new Error("編集対象のサイトがありません。");
        const pending = breakpointRead;
        breakpointRead = undefined;
        return pending ?? editingApi.readBreakpointSettings(signal);
      }),
      save: (input, signal) => conflict(() => request(signal, async () => {
        if (input.siteId !== KAMAKURA_EDITOR_SITE_ID || !validVersion(input.expectedVersion)) throw new Error("保存対象のサイトまたは版が正しくありません。");
        return editingApi.saveBreakpointSettings(input.expectedVersion, input.settings, signal);
      }))
    },
    async discoverPageNodeNames(target, signal) {
      if (target.locale === "en") validEnglishTarget(target);
      else validTarget(target);
      return supportsPageNodeNames(await editingApi.discover(signal), "pages.save");
    },
    readDocument: (target, signal) => request(signal, () => readPageDocument(target, signal)),
    prefetchDocument: (target, signal) => request(signal, () => readPageDocument(target, signal), false),
    applyOperations: (input, signal) => conflict(() => request(signal, async () => {
      const target = validTarget(input.target);
      const result = await editingApi.applyOperations(target, {
        baseVersion: input.baseVersion,
        operationId: input.operationId,
        operations: input.operations,
        ...(input.componentsVersion === undefined ? {} : { componentsVersion: input.componentsVersion }),
        ...(input.presentationVersion === undefined ? {} : { presentationVersion: input.presentationVersion }),
        ...(input.stylesVersion === undefined ? {} : { stylesVersion: input.stylesVersion }),
        ...(input.draftStylesVersion === undefined ? {} : { draftStylesVersion: input.draftStylesVersion }),
        ...(input.cmsBindings === undefined ? {} : { cmsBindings: input.cmsBindings })
      }, signal);
      if (result.status === "valid") throw new Error("dry-run result cannot be used to save a page.");
      return result;
    })),
    saveDraft: (input, signal) => conflict(() => request(signal, async () => {
      if (input.target.locale === "en") {
        const target = validEnglishTarget(input.target), localization = input.localization;
        if (!localization || !localizationVersion(localization.expectedSourceVersion, "p") || !localizationVersion(localization.expectedVersion, "l")
          || !Number.isSafeInteger(localization.expectedOverlayVersion) || localization.expectedOverlayVersion < 1
          || input.expectedVersion !== localization.expectedVersion || !validVersion(input.presentationVersion)) throw new Error("英語下書きの対象または版が正しくありません。");
        const document = parsePageDocument(input.document, catalog.blockContracts);
        if (document.siteId !== target.siteId || document.pageId !== target.pageId || document.locale !== target.locale) throw new Error("英語下書きの対象が一致しません。");
        return parseLocalizedSave(await api(`${localizationPagePath(target)}/save`, "POST", { document, expectedSourceVersion: localization.expectedSourceVersion,
          expectedVersion: localization.expectedVersion, expectedOverlayVersion: localization.expectedOverlayVersion }, signal));
      }
      if (!validVersion(input.expectedVersion)) throw new Error("保存対象の版が正しくありません。");
      if (!validVersion(input.presentationVersion)) throw new Error("表示コンテキストの版が正しくありません。");
      const result = await editingApi.save(validTarget(input.target), input.expectedVersion, input.document, signal);
      if (result.status === "conflict") return result;
      return parseSaved({ status: "saved", version: result.version, revision: result.document.revision });
    })),
    prepareRelease: (input, signal) => request(signal, async () => {
      validTarget(input.target);
      if (!validVersion(input.expectedVersion) || !validVersion(input.presentationVersion) || (input.action === "publish" ? input.revision !== undefined : input.action !== "rollback" || !Number.isSafeInteger(input.revision) || input.revision! <= 0)) throw new Error("公開操作と版の指定が一致しません。");
      const plan = await editingApi.prepareRelease(input.target, { expectedVersion: input.expectedVersion, presentationVersion: input.presentationVersion,
        action: input.action, ...(input.action === "rollback" ? { revision: input.revision } : {}) }, signal);
      const parsed = parsePlan(plan, input, catalog.sites[0]!.domains[0]!);
      releaseOperationIds.set(parsed.confirmationToken, crypto.randomUUID());
      return parsed;
    }),
    release: (plan, signal) => conflict(() => request(signal, async () => {
      if (!releaseMatches(plan, plan, catalog.sites[0]!.domains[0]!)) throw new Error("公開確認が不正です。再度確認してください。");
      const operationId = releaseOperationIds.get(plan.confirmationToken) ?? crypto.randomUUID();
      releaseOperationIds.set(plan.confirmationToken, operationId);
      const result = await editingApi.release(validTarget(plan.target), plan, operationId, signal);
      if (result.status === "conflict") return result;
      const snapshot = await readJapaneseDocument(plan.target, signal);
      releaseOperationIds.delete(plan.confirmationToken);
      return { status: "released" as const, snapshot };
    })),
    prepareReleaseSet: (items: readonly EditingPageReleaseSetItem[], signal: AbortSignal) => request(signal, async () => {
      if (items.length < 2 || items.length > 50) throw new Error("公開対象は2〜50ページにしてください。");
      const seen = new Set<string>();
      for (const item of items) {
        const target = validTarget(item.target), key = `${target.siteId}:${target.pageId}:${target.locale}`;
        if (seen.has(key) || !validVersion(item.expectedVersion)
          || item.componentsVersion !== undefined && !validVersion(item.componentsVersion)
          || item.presentationVersion !== undefined && !validVersion(item.presentationVersion)) throw new Error("公開変更セットの対象または版が正しくありません。");
        seen.add(key);
      }
      return editingApi.preparePageReleaseSet(items, signal);
    }),
    releaseSet: (plan, signal) => conflict(() => request(signal, async () => editingApi.publishPageReleaseSet(plan, signal))),
    releaseSetStatus: (operationId, signal) => request(signal, async () => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(operationId)) throw new Error("公開操作IDが正しくありません。");
      return editingApi.pageReleaseSetStatus(operationId, signal);
    }),
    englishPublication: {
      refresh: (target, signal) => request(signal, async () => (await readJapaneseDocument(target, signal)).englishPublication),
      retry: (target, signal) => conflict(() => request(signal, async () => parseEnglishPublicationAccepted(await api(`${pagePath(target)}/english-publication-retry`, "POST", {}, signal))))
    },
    localization: {
      sourceDocumentLocale: (siteId) => siteId === KAMAKURA_EDITOR_SITE_ID ? "ja" : undefined,
      requestPageTranslation: false,
      readSite: (siteId, signal) => request(signal, async () => {
        if (siteId !== KAMAKURA_EDITOR_SITE_ID) throw new Error("編集対象のサイトがありません。");
        const pending = localizationRead;
        localizationRead = undefined;
        return parseLocalizationSite(await (pending ?? api(`${LOCALIZATION_BASE}/editor/site`, "POST", {}, signal)), currentCatalog);
      }),
      readPage: (target, signal) => request(signal, async () => parseLocalizationPage(await api(localizationPagePath(target), "POST", {}, signal), target, catalog.blockContracts)),
      command: (input, signal) => conflict(() => request(signal, async () => {
        const target = validEnglishTarget(input.target);
        if (!localizationVersion(input.expectedSourceVersion, "p") || !localizationVersion(input.expectedVersion, "l")
          || !Number.isSafeInteger(input.expectedOverlayVersion) || input.expectedOverlayVersion < 1) throw new Error("翻訳操作の版が正しくありません。");
        if (input.action === "request-translation") throw new Error("ページエディタからの翻訳依頼にはまだ対応していません。翻訳画面を利用してください。");
        let body: Record<string, unknown>;
        if (input.action === "adopt-candidate") body = { action: input.action, unitId: input.unitId, candidateVersion: input.candidateVersion };
        else if (input.action === "set-value") body = { action: input.action, unitId: input.unitId, value: input.value, sourceFingerprint: input.sourceFingerprint, expectedEntryVersion: input.expectedEntryVersion };
        else body = { action: input.action, unitId: input.unitId };
        return parseLocalizationCommandResult(await api(`${localizationPagePath(target)}/command`, "POST", { ...body, expectedSourceVersion: input.expectedSourceVersion,
          expectedVersion: input.expectedVersion, expectedOverlayVersion: input.expectedOverlayVersion }, signal));
      })) as Promise<EditorLocalizationCommandResult>
    }
  };
}

function EditorAlert({ status }: { readonly status: EditorApiStatus }) {
  const code = status.status;
  const catalogContractMismatch = status.errorCode === KAMAKURA_CATALOG_CONTRACT_ERROR_CODE;
  if (status.errorCode === VISUAL_EDITOR_FROZEN) return <div className="studio-editor-alert studio-editor-alert-409" role="alert"><strong>保存・公開は凍結中です</strong><span>{FROZEN_MESSAGE}</span></div>;
  return <div className={`studio-editor-alert studio-editor-alert-${code}`} role="alert">
    <strong>{catalogContractMismatch ? "ページ一覧の形式を確認できません" : code === 401 ? "セッションの再確認が必要です" : code === 403 ? "編集権限を確認できません" : code === 404 ? "新形式ページが見つかりません" : code === 503 ? "サイト編集サービスに接続できません" : "編集 API の要求を完了できませんでした"}</strong>
    <span>{catalogContractMismatch ? "ページ一覧の形式に対応できません。編集内容は変更されていません。管理者がサイト側とStudio側の対応状態を確認してください。" : code === 401 ? "編集内容を保持したまま、別タブで Cloudflare Access に再ログインしてから再読込してください。" : code === 403 ? "D1 の Kamakura プロジェクト参加資格が削除または変更されています。Studio 管理者へ確認してください。" : code === 404 ? "ページ一覧を読み直し、新形式ページが存在することを確認してください。" : code === 503 ? "編集内容は変更されていません。時間をおいてから再試行してください。続く場合は管理者へ確認してください。" : "入力内容と接続状態を確認し、エディタ内から再試行してください。"}{status.supportId !== null && <><br />問い合わせID: <code>{status.supportId}</code></>}</span>
  </div>;
}

/** 翻訳一覧からの導線だけが初期対象を指定できる。未知の query は通常のページ一覧を開く。 */
export function kamakuraEditorInitialTarget(search: string): EditorTarget | undefined {
  const query = new URLSearchParams(search);
  const pageId = query.get("page"), locale = query.get("lang");
  if (query.getAll("page").length !== 1 || query.getAll("lang").length !== 1 || pageId === null || !COMMON_PAGE_ID.test(pageId) || locale !== "en") return undefined;
  return { siteId: KAMAKURA_EDITOR_SITE_ID, pageId, locale: "en" };
}

export function KamakuraEditor({ project, environment, initialLoad }: {
  readonly project: Project; readonly environment: string; readonly initialLoad?: () => KamakuraEditorLoad | undefined;
}) {
  if (environment !== "production") throw new Error("Kamakura editor environment is not registered");
  const [catalog, setCatalog] = useState<CatalogState>({ status: "loading" });
  const [status, setStatus] = useState<EditorApiStatus | null>(null);
  const [reload, setReload] = useState(0);
  const catalogCache = useRef<CatalogCache | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setCatalog({ status: "loading" });
    setStatus(null);
    const load = (reload === 0 ? initialLoad?.() : undefined) ?? loadKamakuraEditor(controller, window.location.origin, undefined, catalogCache);
    void load.catalog
      .then((value) => { if (!controller.signal.aborted) { setCatalog({ status: "ready", value, reads: load.reads }); setStatus(null); } })
      .catch((error: unknown) => { if (!controller.signal.aborted) { const failure = statusFromError(error); setCatalog({ status: "error", code: failure.status, errorCode: failure.errorCode, supportId: failure.supportId }); load.abort(); } });
    return () => { controller.abort(); load.abort(); };
  }, [initialLoad, reload]);
  const ready = catalog.status === "ready" ? catalog.value : null;
  const adapter = useMemo(() => catalog.status === "ready"
    ? createProjectEditorAdapter(createKamakuraAdapter(catalog.value, setStatus, window.location.origin, catalog.reads), project) : null, [catalog, project]);
  const assets = useMemo(() => createKamakuraAssetLibrary(window.location.origin), []);
  const blocks = useMemo(() => ready ? createKamakuraEditorBlocks(ready.blockContracts, ready.sites[0]!.domains[0]!) : {}, [ready]);
  const externalFramePolicy = useMemo(() => createExternalFramePolicy({ parentOrigin: window.location.origin, sources: KAMAKURA_ORIGIN_RETAINING_FRAME_SOURCES, siteSources: ready?.sites[0]?.externalFrameSources ?? [] }), [ready]);
  const blankEmbeds = useMemo(() => createBlankEmbedRegistry({
    parentOrigin: window.location.origin,
    entries: [{ key: "public-map", label: "OpenStreetMap", src: "https://www.openstreetmap.org/export/embed.html", sandbox: "same-origin-scripts" }]
  }), []);
  const initialTarget = useMemo(() => kamakuraEditorInitialTarget(window.location.search), []);
  return <main className="studio-editor studio-kamakura-editor">
    {status !== null && <EditorAlert status={status} />}
    {catalog.status === "loading" && <section className="studio-kamakura-state" role="status"><p>ページを読み込んでいます…</p></section>}
    {catalog.status === "error" && <section className="studio-kamakura-state" role="alert"><h1>ページを読み込めませんでした</h1><p>{catalog.errorCode === KAMAKURA_CATALOG_CONTRACT_ERROR_CODE ? "ページ一覧の形式に対応できません。編集内容は変更されていません。管理者へ確認してください。" : catalog.errorCode === VISUAL_EDITOR_FROZEN ? `${FROZEN_MESSAGE}ページ一覧はサイト側の更新後に開けます。` : "編集内容は変更されていません。接続状態を確認して再試行してください。"}</p>{catalog.supportId !== null && <p>問い合わせID: <code>{catalog.supportId}</code></p>}<button type="button" onClick={() => setReload((value) => value + 1)}>再試行</button></section>}
    {ready && (ready.pages.length === 0
      ? <section className="studio-kamakura-state"><h1>編集できるページはありません</h1><p>編集対象のページがありません。ページ一覧を再読み込みしてください。</p><button type="button" onClick={() => setReload((value) => value + 1)}>再読み込み</button></section>
      : adapter && <StudioPageEditor adapter={adapter} {...(initialTarget ? { initialTarget } : {})} externalFramePolicy={externalFramePolicy} blankEmbeds={blankEmbeds} xPostFrameUrl={X_POST_FRAME_URL} enableUrlEmbeds blocks={blocks} assets={assets} insertableBlocks={["ManagedEmbed"]} builder={studioBuilderDefinition} breakpoints={KAMAKURA_BREAKPOINTS} mobilePreviewWidth={480} toolbarStart={<a href={projectRoutePath(window.location.pathname, project.id, project.site.id, "dashboard")} aria-label="ダッシュボードに戻る" title="ダッシュボードに戻る">←</a>} />)}
  </main>;
}
