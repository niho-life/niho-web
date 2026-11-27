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
type EditorSiteSettings = { settings: ReturnType<typeof parseSiteSettings>; version: string; publishedStylesVersion?: string; sitePublicationEpoch?: string };
export type EditorSessionLoad = { session: EditorSession; siteSettings?: EditorSiteSettings; warning?: string };
export type EditorSiteSettingsIdentity = { version?: string | undefined; publishedStylesVersion?: string | undefined; sitePublicationEpoch?: string | undefined };

export function editorSiteSettingsIdentity(value: EditorSiteSettingsIdentity | undefined): string | undefined {
  return value === undefined ? undefined : JSON.stringify([value.version ?? null, value.publishedStylesVersion ?? null, value.sitePublicationEpoch ?? null]);
}

export function sameEditorSiteSettingsIdentity(left: EditorSiteSettingsIdentity | undefined, right: EditorSiteSettingsIdentity | undefined): boolean {
  return editorSiteSettingsIdentity(left) === editorSiteSettingsIdentity(right);
}

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
  private readonly latest = new Map<string, { value: EditorSessionLoad; components?: ComponentLibrary; cachedAt: number }>();
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

  private remember(target: EditorTarget, value: EditorSessionLoad, components?: ComponentLibrary): void {
    const key = this.targetKey(target);
    this.latest.delete(key);
    this.latest.set(key, { value: { session: cleanSessionCopy(value.session), ...(value.siteSettings ? { siteSettings: value.siteSettings } : {}), ...(value.warning ? { warning: value.warning } : {}) }, ...(components ? { components } : {}), cachedAt: Date.now() });
    while (this.latest.size > this.capacity) this.latest.delete(this.latest.keys().next().value!);
  }

  get(target: EditorTarget, snapshot: EditorSnapshot, settingsVersion: string | null | undefined, components?: ComponentLibrary): EditorSessionLoad | undefined {
    if (!snapshotTargetsPage(snapshot, target)) return undefined;
    const key = sessionCacheKey(target, snapshot, settingsVersion, this.componentsKey(components));
    if (!key) return undefined;
    const cached = this.entries.get(key);
    if (!cached) return undefined;
    this.entries.delete(key);
    this.entries.set(key, cached);
    this.remember(target, cached, components);
    return { session: cleanSessionCopy(cached.session), ...(cached.siteSettings ? { siteSettings: cached.siteSettings } : {}), ...(cached.warning ? { warning: cached.warning } : {}) };
  }

  set(target: EditorTarget, snapshot: EditorSnapshot, settingsVersion: string | null | undefined, value: EditorSessionLoad, components?: ComponentLibrary): void {
    const key = sessionCacheKey(target, snapshot, settingsVersion, this.componentsKey(components));
    if (!key) return;
    this.entries.delete(key);
    const cached: EditorSessionLoad = {
      session: cleanSessionCopy(value.session),
      ...(value.siteSettings ? { siteSettings: value.siteSettings } : {}),
      ...(value.warning ? { warning: value.warning } : {})
    };
    this.entries.set(key, cached);
    this.remember(target, cached, components);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }

  /** 最新の保存済みセッションを、版の再確認中にすぐ表示するために取得する。 */
  getLatest(target: EditorTarget, components?: ComponentLibrary, maxAgeMs = 5 * 60_000): EditorSessionLoad | undefined {
    const key = this.targetKey(target), cached = this.latest.get(key);
    if (!cached) return undefined;
    if (Date.now() - cached.cachedAt > maxAgeMs || cached.components !== components) { this.latest.delete(key); return undefined; }
    this.latest.delete(key);
    this.latest.set(key, cached);
    return { session: cleanSessionCopy(cached.value.session), ...(cached.value.siteSettings ? { siteSettings: cached.value.siteSettings } : {}), ...(cached.value.warning ? { warning: cached.value.warning } : {}) };
  }

  /** 保存応答を受け取った最新のクリーンなセッションを再訪時キャッシュへ反映する。 */
  rememberLatest(target: EditorTarget, value: EditorSessionLoad, components?: ComponentLibrary): void { this.remember(target, value, components); }

  /** サーバー側で翻訳済みページが変わったとき、再読込前に古い表示用セッションを破棄する。 */
  invalidateLatest(target: EditorTarget): void { this.latest.delete(this.targetKey(target)); }

  clear(): void { this.entries.clear(); this.latest.clear(); }
}

export type EditorSessionReadOptions = { readonly cache?: EditorSessionCache; readonly snapshot?: EditorSnapshot; readonly siteSettings?: EditorSiteSettings };

/** 文書と任意のサイト設定を独立取得し、設定が無くても単体検証できる文書だけ編集開始する。 */
export async function readEditorSession(adapter: Pick<EditorAdapter, "readDocument" | "readSiteSettings">, target: EditorTarget, signal: AbortSignal, blocks: EditorBlockRegistry = {}, components?: ComponentLibrary, options: EditorSessionReadOptions = {}): Promise<EditorSessionLoad> {
  const settingsRead = options.siteSettings
    ? Promise.resolve().then(() => {
      if (typeof options.siteSettings!.version !== "string" || !options.siteSettings!.version) throw new Error("site settings version is required");
      return { settings: parseSiteSettings(options.siteSettings!.settings), version: options.siteSettings!.version,
        ...(options.siteSettings!.publishedStylesVersion === undefined ? {} : { publishedStylesVersion: options.siteSettings!.publishedStylesVersion }),
        ...(options.siteSettings!.sitePublicationEpoch === undefined ? {} : { sitePublicationEpoch: options.siteSettings!.sitePublicationEpoch }) };
    })
    : adapter.readSiteSettings ? adapter.readSiteSettings(target.siteId, signal).then((snapshot) => {
      if (!snapshot || typeof snapshot.version !== "string" || !snapshot.version) throw new Error("site settings version is required");
      return { settings: parseSiteSettings(snapshot.settings), version: snapshot.version,
        ...(snapshot.publishedStylesVersion === undefined ? {} : { publishedStylesVersion: snapshot.publishedStylesVersion }),
        ...(snapshot.sitePublicationEpoch === undefined ? {} : { sitePublicationEpoch: snapshot.sitePublicationEpoch }) };
    }) : Promise.resolve(undefined);
  // Start feature discovery from the site-settings read before the page request chooses its wire shape.
  const documentRead = options.snapshot ? Promise.resolve(options.snapshot) : adapter.readDocument(target, signal);
  const [documentResult, settingsResult] = await Promise.allSettled([documentRead, settingsRead]);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (documentResult.status === "rejected") throw new EditorSessionLoadError("document", "文書を読み込めませんでした。現在の編集内容は保持されています。", { cause: documentResult.reason });
  let pageSnapshot = documentResult.value;
  let siteSettings = settingsResult.status === "fulfilled" ? settingsResult.value : undefined;
  const pageStylesVersion = (snapshot: EditorSnapshot) => snapshot.draftStylesVersion ?? snapshot.stylesVersion;
  if (siteSettings && pageStylesVersion(pageSnapshot) !== undefined && siteSettings.version !== pageStylesVersion(pageSnapshot)) {
    try {
      if (!adapter.readSiteSettings) throw new Error("site settings cannot be refreshed");
      const refreshed = await adapter.readSiteSettings(target.siteId, signal);
      if (!refreshed || typeof refreshed.version !== "string" || !refreshed.version) throw new Error("site settings version is required");
      siteSettings = { settings: parseSiteSettings(refreshed.settings), version: refreshed.version,
        ...(refreshed.publishedStylesVersion === undefined ? {} : { publishedStylesVersion: refreshed.publishedStylesVersion }),
        ...(refreshed.sitePublicationEpoch === undefined ? {} : { sitePublicationEpoch: refreshed.sitePublicationEpoch }) };
      if (siteSettings.version !== pageStylesVersion(pageSnapshot)) pageSnapshot = await adapter.readDocument(target, signal);
      if (siteSettings.version !== pageStylesVersion(pageSnapshot)) throw new Error("page and site settings versions do not match");
    } catch (error) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      throw new EditorSessionLoadError("site-settings-required", "ページとサイト共通スタイルの版が一致しません。再読込してください。", { cause: error });
    }
  }
  if (settingsResult.status === "fulfilled") {
    const settingsIdentity = editorSiteSettingsIdentity(siteSettings);
    const cached = options.cache?.get(target, pageSnapshot, settingsIdentity, components);
    if (cached) return cached;
    try {
      const loaded = { session: editorSessionFrom(pageSnapshot, target, blocks, components, siteSettings?.settings, !siteSettings), ...(siteSettings ? { siteSettings } : {}) };
      options.cache?.set(target, pageSnapshot, settingsIdentity, loaded, components);
      return loaded;
    } catch (error) {
      throw new EditorSessionLoadError("document", "文書を読み込めませんでした。現在の編集内容は保持されています。", { cause: error });
    }
  }
  const cached = options.cache?.get(target, pageSnapshot, null, components);
  if (cached) return cached;
  try {
    const loaded = { session: editorSessionFrom(pageSnapshot, target, blocks, components, undefined, true), warning: "サイト設定を読み込めませんでした。文書単体で編集を開始しました。" };
    options.cache?.set(target, pageSnapshot, null, loaded, components);
    return loaded;
  } catch (error) {
    throw new EditorSessionLoadError("site-settings-required", "この文書に必要なサイト共通スタイルを読み込めませんでした。現在の編集内容は保持されています。", { cause: error });
  }
}
