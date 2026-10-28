import { useEffect, useMemo, useState } from "react";
import { PageEditor } from "../src/editor.js";
import { createExternalFramePolicy } from "../src/react.js";
import { createProjectEditorAdapter } from "../src/project-editor-adapter.js";
import type { EditorAdapter, EditorBreakpoint, EditorLocalizedPage, EditorLocalizationCommandResult, EditorLocalizationPageSnapshot, EditorLocalizationSiteSnapshot, EditorReleasePlan, EditorReleaseRequest, EditorReleaseResult, EditorSaveResult, EditorSnapshot, EditorTarget } from "../src/editor-types.js";
import type { Project } from "../src/projects.js";
import { studioBuilderDefinition } from "./integration-builder.js";
import { projectRoutePath } from "./project-routes.mjs";
import { kamakuraAssetLibrary } from "./kamakura-assets.js";
import { createKamakuraEditorBlocks } from "./kamakura-editor-blocks.js";
import { parsePageDocument, parseSitePresentation, type BlockContracts } from "../src/core.js";
import { parseLocalizationOverlay, parseSiteLocalizationConfig } from "../src/localization.js";
import { KAMAKURA_CATALOG_CONTRACT_ERROR_CODE, KAMAKURA_CATALOG_CONTRACT_ERROR_STATUS, KAMAKURA_COMMON_PAGE_ID as COMMON_PAGE_ID, KAMAKURA_EDITOR_DOMAIN as DOMAIN, KAMAKURA_EDITOR_SITE_ID, KamakuraCatalogContractError, parseKamakuraCatalog } from "./kamakura-catalog.js";
import type { KamakuraCatalog } from "./kamakura-catalog.js";
import { parseEnglishPublication, parseEnglishPublicationAccepted } from "../src/english-publication.js";
import { parseBreakpointSettings } from "../src/style-model.js";

const BASE = "/api/projects/project-kamakura/sites/kamakura/editor";
const LOCALIZATION_BASE = "/api/projects/project-kamakura/sites/kamakura/localization";
const BREAKPOINTS_BASE = "/api/projects/project-kamakura/sites/kamakura/breakpoints";
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
type CatalogState = { readonly status: "loading" } | { readonly status: "error"; readonly code: number; readonly errorCode: string | null; readonly supportId: string | null } | { readonly status: "ready"; readonly value: KamakuraCatalog };

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

async function api(path: string, method: RequestMethod, body: Record<string, unknown> | undefined, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      signal,
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  } catch (error) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    throw error;
  }
  if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw new EditorApiError(503);
  const value = await response.json() as unknown;
  if (!response.ok) {
    const errorObject = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
    const errorCode = errorObject && typeof errorObject.error === "string"
      ? errorObject.error
      : null;
    throw new EditorApiError(response.status, errorCode, readSupportId(errorObject?.supportId));
  }
  return value;
}

function statusFromError(error: unknown): EditorApiStatus {
  if (error instanceof EditorApiError) return { status: error.status, errorCode: error.code, supportId: error.supportId };
  if (error instanceof KamakuraCatalogContractError) return { status: KAMAKURA_CATALOG_CONTRACT_ERROR_STATUS, errorCode: KAMAKURA_CATALOG_CONTRACT_ERROR_CODE, supportId: null };
  return { status: 503, errorCode: null, supportId: null };
}

function parseSnapshot(value: unknown, target: EditorTarget, blocks: BlockContracts, required = false): EditorSnapshot {
  const source = record(value), document = record(source.document), checked = validTarget(target);
  if (document.siteId !== checked.siteId || document.pageId !== checked.pageId || document.locale !== checked.locale || !validVersion(source.version)) throw new Error("文書の対象または版が一致しません。");
  const parsed = parsePageDocument(source.document, blocks);
  if (required && source.presentation === undefined) throw new Error("このサイトに必要な表示コンテキストがありません。");
  if (source.presentation !== undefined) parseSitePresentation(source.presentation, parsed, blocks);
  const snapshot = structuredClone(value) as EditorSnapshot;
  if (source.englishPublication !== undefined) snapshot.englishPublication = parseEnglishPublication(source.englishPublication);
  return snapshot;
}

function safeLine(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}

function localizationVersion(value: unknown, prefix: "l" | "p" | "s"): value is string {
  return typeof value === "string" && new RegExp(`^${prefix}\\.[0-9a-f]{64}$`, "u").test(value);
}

function parseEnglishSnapshot(value: unknown, target: EditorTarget, blocks: BlockContracts): EditorSnapshot {
  const source = record(value), checked = validEnglishTarget(target);
  if (source.status === "conflict" && Object.keys(source).length === 1) throw new EditorApiError(409, "conflict", null, "英語の編集状態が更新されました。最新の状態を読み直してください。");
  if (source.status === "unavailable" && Object.keys(source).sort().join(",") === "message,status" && safeLine(source.message, 1000)) {
    throw new EditorContentUnavailableError(source.message);
  }
  if (source.status !== "ready" || Object.keys(source).sort().join(",") !== "document,presentation,status,version" || !localizationVersion(source.version, "l")) {
    throw new Error("英語文書の応答が正しくありません。");
  }
  const document = parsePageDocument(source.document, blocks);
  if (document.siteId !== checked.siteId || document.pageId !== checked.pageId || document.locale !== checked.locale) throw new Error("英語文書の対象が一致しません。");
  const presentation = parseSitePresentation(source.presentation, document, blocks);
  if (!validVersion(presentation.version)) throw new Error("英語表示コンテキストの版が正しくありません。");
  return { document, version: source.version, presentation };
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

function parseBreakpointSnapshot(value: unknown) {
  const source = record(value);
  if (Object.keys(source).sort().join(",") !== "settings,version" || !validVersion(source.version)) throw new Error("ブレークポイント設定の応答が正しくありません。");
  return { settings: parseBreakpointSettings(source.settings), version: source.version };
}

function parseBreakpointSaved(value: unknown) {
  const source = record(value);
  if (Object.keys(source).sort().join(",") !== "status,version" || source.status !== "saved" || !validVersion(source.version)) throw new Error("ブレークポイント設定の保存結果が正しくありません。");
  return { status: "saved" as const, version: source.version };
}

function releaseMatches(plan: EditorReleasePlan, request: EditorReleaseRequest): boolean {
  let target: EditorTarget;
  try { target = validTarget(plan.target); validTarget(request.target); }
  catch { return false; }
  if (target.siteId !== request.target.siteId || target.pageId !== request.target.pageId || target.locale !== request.target.locale || !validVersion(plan.expectedVersion) || plan.expectedVersion !== request.expectedVersion || !validVersion(plan.presentationVersion) || plan.presentationVersion !== request.presentationVersion || plan.action !== request.action || plan.revision !== request.revision || plan.domain !== DOMAIN) return false;
  if (plan.action === "publish" ? plan.revision !== undefined : plan.action !== "rollback" || !Number.isSafeInteger(plan.revision) || plan.revision! <= 0) return false;
  if (typeof plan.confirmationToken !== "string" || !CONFIRMATION_TOKEN.test(plan.confirmationToken) || !Array.isArray(plan.changes) || plan.changes.length > 81) return false;
  return plan.changes.every((change) => !!change && typeof change.path === "string" && change.path.length <= 512 && typeof change.before === "string" && change.before.length <= 1_200 && typeof change.after === "string" && change.after.length <= 1_200);
}

function parsePlan(value: unknown, request: EditorReleaseRequest): EditorReleasePlan {
  const plan = structuredClone(value) as EditorReleasePlan;
  if (!releaseMatches(plan, request)) throw new Error("公開確認の対象・版・操作・ドメインが一致しません。再度確認してください。");
  return plan;
}

function parseReleased(value: unknown, target: EditorTarget, blocks: BlockContracts, required = false): Extract<EditorReleaseResult, { status: "released" }> {
  const source = record(value);
  if (source.status !== "released") throw new Error("公開結果が正しくありません。");
  return { status: "released", snapshot: parseSnapshot(source.snapshot, target, blocks, required) };
}

export function createKamakuraAdapter(catalog: KamakuraCatalog, onStatus: (status: EditorApiStatus | null) => void): EditorAdapter {
  async function request<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    try {
      const result = await run();
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      onStatus(null);
      return result;
    } catch (error) {
      if (!signal.aborted && error instanceof EditorApiError && (error.status !== 409 || error.code === VISUAL_EDITOR_FROZEN)) onStatus(statusFromError(error));
      else if (!signal.aborted && !(error instanceof EditorApiError) && !(error instanceof EditorContentUnavailableError)) onStatus(statusFromError(error));
      throw error;
    }
  }
  async function conflict<T>(run: () => Promise<T>): Promise<T | { status: "conflict" }> {
    try { return await run(); }
    catch (error) { if (error instanceof EditorApiError && error.status === 409 && error.code !== VISUAL_EDITOR_FROZEN) return { status: "conflict" }; throw error; }
  }
  return {
    listSites: (signal) => request(signal, async () => catalog.sites),
    listPages: (siteId, signal) => request(signal, async () => {
      if (siteId !== "kamakura") throw new Error("編集対象のサイトがありません。");
      return catalog.pages;
    }),
    breakpointSettings: {
      read: (siteId, signal) => request(signal, async () => {
        if (siteId !== KAMAKURA_EDITOR_SITE_ID) throw new Error("編集対象のサイトがありません。");
        return parseBreakpointSnapshot(await api(BREAKPOINTS_BASE, "GET", undefined, signal));
      }),
      save: (input, signal) => conflict(() => request(signal, async () => {
        if (input.siteId !== KAMAKURA_EDITOR_SITE_ID || !validVersion(input.expectedVersion)) throw new Error("保存対象のサイトまたは版が正しくありません。");
        const settings = parseBreakpointSettings(input.settings);
        return parseBreakpointSaved(await api(BREAKPOINTS_BASE, "PUT", { settings, expectedVersion: input.expectedVersion }, signal));
      }))
    },
    readDocument: (target, signal) => request(signal, async () => target.locale === "en"
      ? parseEnglishSnapshot(await api(`${localizationPagePath(target)}/snapshot`, "POST", {}, signal), target, catalog.blockContracts)
      : parseSnapshot(await api(pagePath(target), "GET", undefined, signal), target, catalog.blockContracts, catalog.nativePresentationPages.includes(target.pageId))),
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
      return parseSaved(await api(`${pagePath(input.target)}/draft`, "PUT", { expectedVersion: input.expectedVersion, presentationVersion: input.presentationVersion, document: input.document }, signal));
    })),
    prepareRelease: (input, signal) => request(signal, async () => {
      validTarget(input.target);
      if (!validVersion(input.expectedVersion) || !validVersion(input.presentationVersion) || (input.action === "publish" ? input.revision !== undefined : input.action !== "rollback" || !Number.isSafeInteger(input.revision) || input.revision! <= 0)) throw new Error("公開操作と版の指定が一致しません。");
      const body = { expectedVersion: input.expectedVersion, presentationVersion: input.presentationVersion, action: input.action, ...(input.action === "rollback" ? { revision: input.revision } : {}) };
      return parsePlan(await api(`${pagePath(input.target)}/release-plan`, "POST", body, signal), input);
    }),
    release: (plan, signal) => conflict(() => request(signal, async () => {
      if (!releaseMatches(plan, plan)) throw new Error("公開確認が不正です。再度確認してください。");
      return parseReleased(await api(`${pagePath(plan.target)}/release`, "POST", { expectedVersion: plan.expectedVersion, presentationVersion: plan.presentationVersion, confirmationToken: plan.confirmationToken }, signal), plan.target, catalog.blockContracts, catalog.nativePresentationPages.includes(plan.target.pageId));
    })),
    englishPublication: {
      refresh: (target, signal) => request(signal, async () => parseSnapshot(await api(pagePath(target), "GET", undefined, signal), target, catalog.blockContracts, catalog.nativePresentationPages.includes(target.pageId)).englishPublication),
      retry: (target, signal) => conflict(() => request(signal, async () => parseEnglishPublicationAccepted(await api(`${pagePath(target)}/english-publication-retry`, "POST", {}, signal))))
    },
    localization: {
      requestPageTranslation: false,
      readSite: (siteId, signal) => request(signal, async () => {
        if (siteId !== KAMAKURA_EDITOR_SITE_ID) throw new Error("編集対象のサイトがありません。");
        return parseLocalizationSite(await api(`${LOCALIZATION_BASE}/editor/site`, "POST", {}, signal), catalog);
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

export function KamakuraEditor({ project, environment }: { readonly project: Project; readonly environment: string }) {
  if (environment !== "production") throw new Error("Kamakura editor environment is not registered");
  const [catalog, setCatalog] = useState<CatalogState>({ status: "loading" });
  const [status, setStatus] = useState<EditorApiStatus | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setCatalog({ status: "loading" });
    setStatus(null);
    void api(`${BASE}/catalog`, "GET", undefined, controller.signal)
      .then(parseKamakuraCatalog)
      .then((value) => { if (!controller.signal.aborted) { setCatalog({ status: "ready", value }); setStatus(null); } })
      .catch((error: unknown) => { if (!controller.signal.aborted) { const failure = statusFromError(error); setCatalog({ status: "error", code: failure.status, errorCode: failure.errorCode, supportId: failure.supportId }); } });
    return () => controller.abort();
  }, [reload]);
  const ready = catalog.status === "ready" ? catalog.value : null;
  const adapter = useMemo(() => ready ? createProjectEditorAdapter(createKamakuraAdapter(ready, setStatus), project) : null, [ready, project]);
  const blocks = useMemo(() => ready ? createKamakuraEditorBlocks(ready.blockContracts) : {}, [ready]);
  const externalFramePolicy = useMemo(() => createExternalFramePolicy({ parentOrigin: window.location.origin, sources: ["https://www.google.com/maps/embed"] }), []);
  const initialTarget = useMemo(() => kamakuraEditorInitialTarget(window.location.search), []);
  return <main className="studio-editor studio-kamakura-editor">
    {status !== null && <EditorAlert status={status} />}
    {catalog.status === "loading" && <section className="studio-kamakura-state" role="status"><p>ページを読み込んでいます…</p></section>}
    {catalog.status === "error" && <section className="studio-kamakura-state" role="alert"><h1>ページを読み込めませんでした</h1><p>{catalog.errorCode === KAMAKURA_CATALOG_CONTRACT_ERROR_CODE ? "ページ一覧の形式に対応できません。編集内容は変更されていません。管理者へ確認してください。" : catalog.errorCode === VISUAL_EDITOR_FROZEN ? `${FROZEN_MESSAGE}ページ一覧はサイト側の更新後に開けます。` : "編集内容は変更されていません。接続状態を確認して再試行してください。"}</p>{catalog.supportId !== null && <p>問い合わせID: <code>{catalog.supportId}</code></p>}<button type="button" onClick={() => setReload((value) => value + 1)}>再試行</button></section>}
    {ready && (ready.pages.length === 0
      ? <section className="studio-kamakura-state"><h1>編集できるページはありません</h1><p>編集対象のページがありません。ページ一覧を再読み込みしてください。</p><button type="button" onClick={() => setReload((value) => value + 1)}>再読み込み</button></section>
      : adapter && <PageEditor adapter={adapter} {...(initialTarget ? { initialTarget } : {})} externalFramePolicy={externalFramePolicy} blocks={blocks} assets={kamakuraAssetLibrary} insertableBlocks={["ManagedEmbed"]} builder={studioBuilderDefinition} breakpoints={KAMAKURA_BREAKPOINTS} mobilePreviewWidth={480} toolbarStart={<a href={projectRoutePath(window.location.pathname, project.id, project.site.id, "dashboard")} aria-label="ダッシュボードに戻る" title="ダッシュボードに戻る">←</a>} />)}
  </main>;
}
