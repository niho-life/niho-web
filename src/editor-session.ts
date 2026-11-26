import { operationQueue, type EditorOperationQueue } from "./editor-operation-queue.js";
import { PAGE_OPERATION_VERSIONS, type PageOperationVersions } from "./editing-page-operations.js";
import { parsePageDocument } from "./document.js";
import { parseSiteSettings } from "./pages.js";
import { fingerprint, parseEditorReadOnly, sameTarget, type EditorHistory } from "./editor-model.js";
import type { ComponentLibrary } from "./types.js";
import type { EditorAdapter, EditorBlockRegistry, EditorLock, EditorReadOnly, EditorSnapshot, EditorTarget } from "./editor-types.js";
import type { SiteStyles } from "./site-styles.js";
import { parseSitePresentation } from "./presentation.js";
import type { SitePresentation } from "./types.js";
import { parseEnglishPublication } from "./english-publication.js";
import { parseCmsPageBindings, type CmsPageBindingsDocument } from "./cms-page-bindings.js";

export type EditorSession = { target: EditorTarget; history: EditorHistory; version: string; saved: string; hasSavedDraft?: boolean | undefined; locks: readonly EditorLock[]; releases: NonNullable<EditorSnapshot["releases"]>; readOnly?: EditorReadOnly; siteStyles?: SiteStyles; presentation?: SitePresentation; operationQueue: EditorOperationQueue; dependencyVersions: PageOperationVersions; englishPublication?: EditorSnapshot["englishPublication"]; cmsBindings?: CmsPageBindingsDocument | null; savedCmsBindings?: string; selfContained: boolean };
export type EditorSessionLoad = { session: EditorSession; warning?: string };

export class EditorSessionLoadError extends Error {
  constructor(readonly reason: "document" | "site-settings-required", message: string, options?: ErrorOptions) { super(message, options); this.name = "EditorSessionLoadError"; }
}

export function editorSessionFrom(snapshot: EditorSnapshot, target: EditorTarget, blocks: EditorBlockRegistry, components?: ComponentLibrary, siteStyles?: SiteStyles, selfContained = false): EditorSession {
  const document = parsePageDocument(snapshot.document, blocks, { ...(components ? { components } : {}), ...(siteStyles ? { siteStyles } : {}) });
  if (!sameTarget(document, target) || typeof snapshot.version !== "string" || !snapshot.version) throw new Error("読込対象が一致しません。");
  if (snapshot.hasSavedDraft !== undefined && typeof snapshot.hasSavedDraft !== "boolean") throw new Error("公開状態が正しくありません。");
  const dependencyVersions: PageOperationVersions = Object.fromEntries(PAGE_OPERATION_VERSIONS.flatMap((key) => {
    const value = snapshot[key];
    if (value === undefined) return [];
    if (typeof value !== "string" || !value || value.length > 200) throw new Error("依存先の版が正しくありません。");
    return [[key, value]];
  }));
  const readOnly = parseEditorReadOnly(snapshot.readOnly);
  const presentation = snapshot.presentation === undefined ? undefined : parseSitePresentation(snapshot.presentation, document, blocks);
  const englishPublication = snapshot.englishPublication === undefined ? undefined : parseEnglishPublication(snapshot.englishPublication);
  const cmsBindings = snapshot.cmsBindings == null ? snapshot.cmsBindings : parseCmsPageBindings(snapshot.cmsBindings, target);
  return { ...(siteStyles ? { siteStyles } : {}), ...(presentation ? { presentation } : {}), ...(englishPublication ? { englishPublication } : {}), target, history: { past: [], present: document, future: [] }, version: snapshot.version, dependencyVersions, operationQueue: operationQueue(document), saved: fingerprint(document), locks: snapshot.locks ?? [], releases: snapshot.releases ?? [], selfContained,
    ...(cmsBindings === undefined ? {} : { cmsBindings, savedCmsBindings: JSON.stringify(cmsBindings) }),
    ...(snapshot.hasSavedDraft === undefined ? {} : { hasSavedDraft: snapshot.hasSavedDraft }), ...(readOnly ? { readOnly } : {}) };
}

function snapshotTargetsPage(snapshot: EditorSnapshot, target: EditorTarget): boolean {
  if (!snapshot.document || typeof snapshot.document !== "object" || Array.isArray(snapshot.document)) return false;
  const document = snapshot.document as Record<string, unknown>;
  return document.siteId === target.siteId && document.pageId === target.pageId && document.locale === target.locale;
}

function sessionCacheKey(target: EditorTarget, snapshot: EditorSnapshot, settingsVersion: string | null | undefined): string | undefined {
  const presentationVersion = snapshot.presentation && typeof snapshot.presentation === "object"
    ? (snapshot.presentation as { readonly version?: unknown }).version : undefined;
  try {
    return JSON.stringify([
      target.siteId, target.pageId, target.locale, snapshot.version,
      snapshot.componentsVersion ?? null, snapshot.presentationVersion ?? null, snapshot.stylesVersion ?? null,
      settingsVersion === undefined ? "unavailable" : settingsVersion === null ? "failed" : settingsVersion,
      snapshot.hasSavedDraft ?? null, snapshot.locks ?? null, snapshot.releases ?? null,
      snapshot.readOnly ?? null, snapshot.englishPublication ?? null, presentationVersion ?? null, snapshot.cmsBindings !== undefined
    ]);
  } catch { return undefined; }
}

function cleanSessionCopy(session: EditorSession): EditorSession {
  const document = session.history.present;
  return {
    ...session,
    history: { past: [], present: document, future: [] },
    saved: fingerprint(document),
    operationQueue: operationQueue(document)
  };
}

/** A small per-editor LRU keyed by target and the server's current page/dependency versions. */
export class EditorSessionCache {
  private readonly entries = new Map<string, EditorSessionLoad>();

  constructor(private readonly capacity = 4) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("Editor session cache capacity must be positive");
  }

  get(target: EditorTarget, snapshot: EditorSnapshot, settingsVersion: string | null | undefined, components?: ComponentLibrary): EditorSessionLoad | undefined {
    if (components) return undefined;
    if (!snapshotTargetsPage(snapshot, target)) return undefined;
    const key = sessionCacheKey(target, snapshot, settingsVersion);
    if (!key) return undefined;
    const cached = this.entries.get(key);
    if (!cached) return undefined;
    this.entries.delete(key);
    this.entries.set(key, cached);
    return { session: cleanSessionCopy(cached.session), ...(cached.warning ? { warning: cached.warning } : {}) };
  }

  set(target: EditorTarget, snapshot: EditorSnapshot, settingsVersion: string | null | undefined, value: EditorSessionLoad, components?: ComponentLibrary): void {
    if (components) return;
    const key = sessionCacheKey(target, snapshot, settingsVersion);
    if (!key) return;
    this.entries.delete(key);
    this.entries.set(key, { session: cleanSessionCopy(value.session), ...(value.warning ? { warning: value.warning } : {}) });
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }

  clear(): void { this.entries.clear(); }
}

export type EditorSessionReadOptions = { readonly cache?: EditorSessionCache; readonly snapshot?: EditorSnapshot; readonly siteSettings?: { readonly settings: ReturnType<typeof parseSiteSettings>; readonly version: string } };

/** 文書と任意のサイト設定を独立取得し、設定が無くても単体検証できる文書だけ編集開始する。 */
export async function readEditorSession(adapter: Pick<EditorAdapter, "readDocument" | "readSiteSettings">, target: EditorTarget, signal: AbortSignal, blocks: EditorBlockRegistry = {}, components?: ComponentLibrary, options: EditorSessionReadOptions = {}): Promise<EditorSessionLoad> {
  const settingsRead = options.siteSettings
    ? Promise.resolve().then(() => {
      if (typeof options.siteSettings!.version !== "string" || !options.siteSettings!.version) throw new Error("site settings version is required");
      return { settings: parseSiteSettings(options.siteSettings!.settings), version: options.siteSettings!.version };
    })
    : adapter.readSiteSettings ? adapter.readSiteSettings(target.siteId, signal).then((snapshot) => {
      if (!snapshot || typeof snapshot.version !== "string" || !snapshot.version) throw new Error("site settings version is required");
      return { settings: parseSiteSettings(snapshot.settings), version: snapshot.version };
    }) : Promise.resolve(undefined);
  // Start feature discovery from the site-settings read before the page request chooses its wire shape.
  const documentRead = options.snapshot ? Promise.resolve(options.snapshot) : adapter.readDocument(target, signal);
  const [documentResult, settingsResult] = await Promise.allSettled([documentRead, settingsRead]);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (documentResult.status === "rejected") throw new EditorSessionLoadError("document", "文書を読み込めませんでした。現在の編集内容は保持されています。", { cause: documentResult.reason });
  if (settingsResult.status === "fulfilled") {
    const settings = settingsResult.value;
    const cached = options.cache?.get(target, documentResult.value, settings?.version, components);
    if (cached) return cached;
    try {
      const loaded = { session: editorSessionFrom(documentResult.value, target, blocks, components, settings?.settings, !settings) };
      options.cache?.set(target, documentResult.value, settings?.version, loaded, components);
      return loaded;
    } catch (error) {
      throw new EditorSessionLoadError("document", "文書を読み込めませんでした。現在の編集内容は保持されています。", { cause: error });
    }
  }
  const cached = options.cache?.get(target, documentResult.value, null, components);
  if (cached) return cached;
  try {
    const loaded = { session: editorSessionFrom(documentResult.value, target, blocks, components, undefined, true), warning: "サイト設定を読み込めませんでした。文書単体で編集を開始しました。" };
    options.cache?.set(target, documentResult.value, null, loaded, components);
    return loaded;
  } catch (error) {
    throw new EditorSessionLoadError("site-settings-required", "この文書に必要なサイト共通スタイルを読み込めませんでした。現在の編集内容は保持されています。", { cause: error });
  }
}
