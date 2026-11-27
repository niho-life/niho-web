import { operationQueue, type EditorOperationQueue } from "./editor-operation-queue.js";
import { PAGE_OPERATION_VERSIONS, type PageOperationVersions } from "./editing-page-operations.js";
import { parsePageDocument } from "./document.js";
import { parseSiteSettings } from "./pages.js";
import { fingerprint, parseEditorReadOnly, sameTarget, type EditorHistory } from "./editor-model.js";
import type { ComponentLibrary } from "./types.js";
import type { EditorAdapter, EditorBlockRegistry, EditorDocumentRead, EditorLock, EditorReadOnly, EditorSiteSettingsSnapshot, EditorSnapshot, EditorTarget } from "./editor-types.js";
import { beginEditorPerformance, finishEditorPerformance, markEditorReadCacheHit } from "./editor-performance.js";
import type { SiteStyles } from "./site-styles.js";
import { parseSitePresentation } from "./presentation.js";
import type { SitePresentation } from "./types.js";
import { parseEnglishPublication } from "./english-publication.js";
import { parseCmsPageBindings, type CmsPageBindingsDocument } from "./cms-page-bindings.js";

export type EditorSession = { target: EditorTarget; history: EditorHistory; version: string; saved: string; hasSavedDraft?: boolean | undefined; locks: readonly EditorLock[]; releases: NonNullable<EditorSnapshot["releases"]>; readOnly?: EditorReadOnly; siteStyles?: SiteStyles; presentation?: SitePresentation; operationQueue: EditorOperationQueue; dependencyVersions: PageOperationVersions; englishPublication?: EditorSnapshot["englishPublication"]; cmsBindings?: CmsPageBindingsDocument | null; savedCmsBindings?: string; selfContained: boolean };
export type EditorSessionSiteSettings = Omit<EditorSiteSettingsSnapshot, "settings"> & { readonly settings: ReturnType<typeof parseSiteSettings> };
export type EditorSessionLoad = { session: EditorSession; siteSettings?: EditorSessionSiteSettings; warning?: string; etag?: string };

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

function sessionCacheKey(target: EditorTarget, snapshot: EditorSnapshot, settingsVersion: string | null | undefined, componentsKey: number | null): string | undefined {
  const presentationVersion = snapshot.presentation && typeof snapshot.presentation === "object"
    ? (snapshot.presentation as { readonly version?: unknown }).version : undefined;
  try {
    return JSON.stringify([
      target.siteId, target.pageId, target.locale, snapshot.version, componentsKey,
      snapshot.componentsVersion ?? null, snapshot.presentationVersion ?? null,
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

/** A small LRU containing one clean session and its validator per page. */
export class EditorSessionCache {
  private readonly sessions = new Map<string, { value: EditorSessionLoad; components?: ComponentLibrary; settingsVersion: string | null | undefined; snapshotKey?: string; cachedAt: number }>();
  private readonly componentKeys = new WeakMap<ComponentLibrary, number>();
  private nextComponentKey = 0;
  constructor(private readonly capacity = 4) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("Editor session cache capacity must be positive");
  }

  private targetKey(target: EditorTarget): string { return JSON.stringify([target.siteId, target.pageId, target.locale]); }

  private componentsKey(components?: ComponentLibrary): number | null {
    if (!components) return null;
    let key = this.componentKeys.get(components);
    if (key === undefined) { key = ++this.nextComponentKey; this.componentKeys.set(components, key); }
    return key;
  }

  private copy(value: EditorSessionLoad): EditorSessionLoad {
    return { session: cleanSessionCopy(value.session), ...(value.siteSettings ? { siteSettings: value.siteSettings } : {}),
      ...(value.warning ? { warning: value.warning } : {}), ...(value.etag ? { etag: value.etag } : {}) };
  }

  get(target: EditorTarget, snapshot: EditorSnapshot, settingsVersion: string | null | undefined, components?: ComponentLibrary): EditorSessionLoad | undefined {
    if (!snapshotTargetsPage(snapshot, target)) return undefined;
    const cached = this.sessions.get(this.targetKey(target));
    const snapshotKey = sessionCacheKey(target, snapshot, settingsVersion, this.componentsKey(components));
    if (!cached || !snapshotKey || cached.snapshotKey !== snapshotKey || cached.components !== components) return undefined;
    this.sessions.delete(this.targetKey(target));
    this.sessions.set(this.targetKey(target), cached);
    return this.copy(cached.value);
  }

  getLatest(target: EditorTarget, components?: ComponentLibrary, maxAgeMs = 5 * 60_000, settingsVersion?: string | null): EditorSessionLoad | undefined {
    const key = this.targetKey(target), cached = this.sessions.get(key);
    if (!cached) return undefined;
    if (Date.now() - cached.cachedAt > maxAgeMs || cached.components !== components
      || settingsVersion !== undefined && cached.settingsVersion !== settingsVersion) {
      this.sessions.delete(key);
      return undefined;
    }
    this.sessions.delete(key);
    this.sessions.set(key, cached);
    return this.copy(cached.value);
  }

  set(target: EditorTarget, snapshot: EditorSnapshot, settingsVersion: string | null | undefined, value: EditorSessionLoad, components?: ComponentLibrary): void {
    this.remember(target, value, components, settingsVersion, value.etag, sessionCacheKey(target, snapshot, settingsVersion, this.componentsKey(components)));
  }

  private remember(target: EditorTarget, value: EditorSessionLoad, components?: ComponentLibrary, settingsVersion?: string | null, etag?: string, snapshotKey?: string): void {
    const key = this.targetKey(target);
    const copy = this.copy({ ...value, ...(etag ? { etag } : {}) });
    this.sessions.delete(key);
    this.sessions.set(key, { value: copy, ...(components ? { components } : {}), settingsVersion, ...(snapshotKey ? { snapshotKey } : {}), cachedAt: Date.now() });
    while (this.sessions.size > this.capacity) this.sessions.delete(this.sessions.keys().next().value!);
  }

  /** 保存応答を受け取った最新のクリーンなセッションを再訪時キャッシュへ反映する。 */
  rememberLatest(target: EditorTarget, value: EditorSessionLoad, components?: ComponentLibrary, settingsVersion?: string | null): void {
    this.remember(target, value, components, settingsVersion);
  }

  /** サーバー側で翻訳済みページが変わったとき、再読込前に古い表示用セッションを破棄する。 */
  invalidateLatest(target: EditorTarget): void { this.sessions.delete(this.targetKey(target)); }

  clear(): void { this.sessions.clear(); }
}

export type EditorSessionReadOptions = {
  readonly cache?: EditorSessionCache;
  readonly cached?: EditorSessionLoad;
  readonly snapshot?: EditorSnapshot;
  readonly siteSettings?: EditorSessionSiteSettings;
};

/** 文書と任意のサイト設定を独立取得し、設定が無くても単体検証できる文書だけ編集開始する。 */
export async function readEditorSession(adapter: Pick<EditorAdapter, "readDocument" | "readDocumentIfChanged" | "readSiteSettings">, target: EditorTarget, signal: AbortSignal, blocks: EditorBlockRegistry = {}, components?: ComponentLibrary, options: EditorSessionReadOptions = {}): Promise<EditorSessionLoad> {
  const settingsRead = options.siteSettings
    ? Promise.resolve().then(() => {
      if (typeof options.siteSettings!.version !== "string" || !options.siteSettings!.version) throw new Error("site settings version is required");
      return { settings: parseSiteSettings(options.siteSettings!.settings), version: options.siteSettings!.version,
        ...(options.siteSettings!.publishedVersion === undefined ? {} : { publishedVersion: options.siteSettings!.publishedVersion }),
        ...(options.siteSettings!.publishedStyles === undefined ? {} : { publishedStyles: options.siteSettings!.publishedStyles }) };
    })
    : adapter.readSiteSettings ? adapter.readSiteSettings(target.siteId, signal).then((snapshot) => {
      if (!snapshot || typeof snapshot.version !== "string" || !snapshot.version) throw new Error("site settings version is required");
      return { settings: parseSiteSettings(snapshot.settings), version: snapshot.version,
        ...(snapshot.publishedVersion === undefined ? {} : { publishedVersion: snapshot.publishedVersion }),
        ...(snapshot.publishedStyles === undefined ? {} : { publishedStyles: snapshot.publishedStyles }) };
    }) : Promise.resolve(undefined);
  const readDocument = (): Promise<EditorDocumentRead> => options.snapshot
    ? Promise.resolve({ status: "modified", snapshot: options.snapshot })
    : adapter.readDocumentIfChanged
      ? adapter.readDocumentIfChanged(target, options.cached?.etag, signal)
      : adapter.readDocument(target, signal).then((snapshot) => ({ status: "modified", snapshot }));
  const [documentResult, settingsResult] = await Promise.allSettled([readDocument(), settingsRead]);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (documentResult.status === "rejected") throw new EditorSessionLoadError("document", "文書を読み込めませんでした。現在の編集内容は保持されています。", { cause: documentResult.reason });
  let documentRead = documentResult.value;
  let siteSettings = settingsResult.status === "fulfilled" ? settingsResult.value : undefined;
  if (documentRead.status === "not-modified") {
    if (!options.cached) throw new EditorSessionLoadError("document", "キャッシュを確認できませんでした。ページを再読み込みしてください。");
    if (adapter.readDocumentIfChanged) markEditorReadCacheHit();
    if (siteSettings && options.cached.siteSettings?.version !== siteSettings.version) {
      if (!adapter.readDocumentIfChanged) throw new EditorSessionLoadError("document", "ページを再読み込みできませんでした。");
      try { documentRead = await adapter.readDocumentIfChanged(target, undefined, signal); }
      catch (error) { throw new EditorSessionLoadError("document", "文書を読み込めませんでした。現在の編集内容は保持されています。", { cause: error }); }
      if (documentRead.status === "not-modified") throw new EditorSessionLoadError("document", "ページを再読み込みできませんでした。");
    } else {
      return { ...options.cached, ...(siteSettings ? { siteSettings } : {}), etag: documentRead.etag };
    }
  }
  if (options.cached && adapter.readDocumentIfChanged) markEditorReadCacheHit();
  const pageSnapshot = documentRead.snapshot;
  const settingsVersion = settingsResult.status === "fulfilled" ? siteSettings?.version ?? null : null;
  const cachedSession = options.cache?.get(target, pageSnapshot, settingsVersion, components);
  const sessionBuild = cachedSession ? null : beginEditorPerformance("session-build");
  try {
    if (settingsResult.status === "fulfilled") {
      const loaded = { session: cachedSession?.session ?? editorSessionFrom(pageSnapshot, target, blocks, components, siteSettings?.settings, !siteSettings),
        ...(siteSettings ? { siteSettings } : {}), ...(documentRead.etag ? { etag: documentRead.etag } : {}) };
      options.cache?.set(target, pageSnapshot, settingsVersion, loaded, components);
      finishEditorPerformance(sessionBuild);
      return loaded;
    }
    try {
      const loaded = { session: cachedSession?.session ?? editorSessionFrom(pageSnapshot, target, blocks, components, undefined, true),
        warning: "サイト設定を読み込めませんでした。文書単体で編集を開始しました。", ...(documentRead.etag ? { etag: documentRead.etag } : {}) };
      options.cache?.set(target, pageSnapshot, settingsVersion, loaded, components);
      finishEditorPerformance(sessionBuild);
      return loaded;
    } catch (error) {
      throw new EditorSessionLoadError("site-settings-required", "この文書に必要なサイト共通スタイルを読み込めませんでした。現在の編集内容は保持されています。", { cause: error });
    }
  } catch (error) {
    finishEditorPerformance(sessionBuild, "failed");
    if (error instanceof EditorSessionLoadError) throw error;
    throw new EditorSessionLoadError("document", "文書を読み込めませんでした。現在の編集内容は保持されています。", { cause: error });
  }
}
