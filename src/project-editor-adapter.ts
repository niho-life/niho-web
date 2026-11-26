import { parseSiteStyles } from "./site-styles.js";
import { fingerprint, normalizePageChange, parseEditorReadOnly, validatePageChangePlan, validateReleasePlan } from "./editor-model.js";
import { parseEditorLocaleReleaseApplyResult, parseEditorLocaleReleasePlan, parseEditorLocaleReleaseState } from "./editor-locale-release.js";
import type { EditingPageReleaseSetApplyResult, EditingPageReleaseSetItem, EditingPageReleaseSetPlan } from "./editing-api.js";
import type { EditorAdapter, EditorComponentAdapter, EditorLocaleReleaseApplyRequest, EditorLocaleReleasePrepareRequest, EditorLocalizationAdapter, EditorLocalizationCommand, EditorPage, EditorPageChange, EditorPagePublication, EditorReleasePlan, EditorReleaseRequest, EditorSite, EditorStructuredDataPreset, EditorTarget } from "./editor-types.js";
import { parseRevisionEntry, parseRevisionPage } from "./history.js";
import { parseSiteSettings } from "./pages.js";
import { parseProject, type Project } from "./projects.js";
import { parseBreakpointSettings } from "./style-model.js";
import { identifier, keys, line, record } from "./validation-utils.js";

function targetForProject(target: EditorTarget, site: EditorSite): EditorTarget {
  const normalized: EditorTarget = { siteId: target.siteId, pageId: target.pageId, locale: target.locale };
  if (normalized.siteId !== site.id) throw new Error("プロジェクトのサイトと編集対象が一致しません。");
  return normalized;
}

function sameSite(left: EditorSite, right: EditorSite): boolean {
  return left.id === right.id && left.domains.length === right.domains.length &&
    new Set(left.domains).size === left.domains.length && left.domains.every((domain) => right.domains.includes(domain));
}

function siteFrameSources(input: unknown, domains: readonly string[]): string[] {
  if (!Array.isArray(input) || input.length > 16) throw new Error("サイトの外部フレーム設定が正しくありません。");
  return input.map((source) => {
    if (typeof source !== "string") throw new Error("サイトの外部フレーム設定が正しくありません。");
    let url: URL;
    try { url = new URL(source); } catch { throw new Error("サイトの外部フレーム設定が正しくありません。"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || domains.includes(url.origin)) throw new Error("サイトの外部フレーム設定が正しくありません。");
    return source;
  });
}

function assertDocumentTarget(document: unknown, target: EditorTarget): void {
  const value = record(document, "document");
  if (value.siteId !== target.siteId || value.pageId !== target.pageId || value.locale !== target.locale) throw new Error("文書の対象が一致しません。");
}

function assertPresentationTarget(presentation: unknown, target: EditorTarget): void {
  if (presentation === undefined) return;
  const value = record(presentation, "presentation"), shared = record(value.shared, "presentation.shared");
  if (value.siteId !== target.siteId || value.locale !== target.locale) throw new Error("表示コンテキストの対象が一致しません。");
  for (const name of ["header", "footer"] as const) {
    const document = record(shared[name], `presentation.shared.${name}`);
    if (document.siteId !== target.siteId || document.locale !== target.locale) throw new Error("共有文書の対象が一致しません。");
  }
  if (value.overlays !== undefined) {
    if (!Array.isArray(value.overlays)) throw new Error("表示コンテキストのoverlayが正しくありません。");
    for (const [index, raw] of value.overlays.entries()) {
      const overlay = record(raw, `presentation.overlays[${index}]`), document = record(overlay.document, `presentation.overlays[${index}].document`);
      if (document.siteId !== target.siteId || document.locale !== target.locale) throw new Error("共有overlay文書の対象が一致しません。");
    }
  }
  if (value.hostViews !== undefined) {
    if (!Array.isArray(value.hostViews)) throw new Error("表示コンテキストのhost viewが正しくありません。");
    for (const [index, raw] of value.hostViews.entries()) {
      const view = record(raw, `presentation.hostViews[${index}]`), document = record(view.document, `presentation.hostViews[${index}].document`);
      if (document.siteId !== target.siteId || document.locale !== target.locale) throw new Error("host view文書の対象が一致しません。");
    }
  }
}

function assertLibrarySite(library: unknown, site: EditorSite): void {
  if (record(library, "library").siteId !== site.id) throw new Error("コンポーネントライブラリの対象サイトが一致しません。");
}

function releaseRequest(request: EditorReleaseRequest, target: EditorTarget): EditorReleaseRequest {
  return {
    target,
    expectedVersion: request.expectedVersion,
    action: request.action,
    ...(request.revision === undefined ? {} : { revision: request.revision }),
    ...(request.componentsVersion === undefined ? {} : { componentsVersion: request.componentsVersion }),
    ...(request.presentationVersion === undefined ? {} : { presentationVersion: request.presentationVersion })
  };
}

function releaseValue(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${name}が正しくありません。`);
  return value;
}
function localeReleasePrepareRequest(request: EditorLocaleReleasePrepareRequest, site: EditorSite): EditorLocaleReleasePrepareRequest {
  if (request.siteId !== site.id || request.locale !== "ja" && request.locale !== "en" || request.action !== "publish" && request.action !== "rollback") throw new Error("プロジェクト外の言語版は操作できません。");
  if (request.action === "rollback" !== (request.rollbackReleaseId !== undefined)) throw new Error("言語版の復元対象が正しくありません。");
  return { siteId: site.id, locale: request.locale, action: request.action, expectedSiteVersion: releaseValue(request.expectedSiteVersion, "サイト版"),
    expectedCurrentVersion: request.expectedCurrentVersion === null ? null : releaseValue(request.expectedCurrentVersion, "現在の公開版"),
    ...(request.rollbackReleaseId === undefined ? {} : { rollbackReleaseId: releaseValue(request.rollbackReleaseId, "復元対象") }) };
}
function localeReleaseApplyRequest(request: EditorLocaleReleaseApplyRequest, site: EditorSite): EditorLocaleReleaseApplyRequest {
  if (request.siteId !== site.id || request.locale !== "ja" && request.locale !== "en") throw new Error("プロジェクト外の言語版は操作できません。");
  return { siteId: site.id, locale: request.locale, confirmationToken: releaseValue(request.confirmationToken, "確認情報", 512),
    expectedCurrentVersion: request.expectedCurrentVersion === null ? null : releaseValue(request.expectedCurrentVersion, "現在の公開版"),
    optimisticVersion: releaseValue(request.optimisticVersion, "確認用の版"), preparedReleaseId: releaseValue(request.preparedReleaseId, "準備した公開版"),
    preparedVersion: releaseValue(request.preparedVersion, "準備した版") };
}

/** 既知の任意項目だけを検証して渡す。 */
function pageEntry(page: EditorPage): EditorPage {
  const entry: EditorPage = { siteId: page.siteId, pageId: page.pageId, locale: page.locale, title: page.title };
  if (page.path !== undefined) {
    if (typeof page.path !== "string" || page.path.length > 160 || /[\u0000-\u001f\u007f]/u.test(page.path)) throw new Error("ページ一覧のパスが正しくありません。");
    entry.path = page.path;
  }
  if (page.kind !== undefined) {
    if (!["page", "template", "shared"].includes(page.kind)) throw new Error("ページ一覧の種類が正しくありません。");
    entry.kind = page.kind;
  }
  if (page.visibility !== undefined) {
    if (page.visibility !== "public" && page.visibility !== "private") throw new Error("ページ一覧の公開状態が正しくありません。");
    entry.visibility = page.visibility;
  }
  if (page.published !== undefined) {
    if (typeof page.published !== "boolean") throw new Error("ページ一覧の公開版の情報が正しくありません。");
    entry.published = page.published;
  }
  if (page.publication !== undefined) entry.publication = parsePagePublication(page.publication);
  return entry;
}

/** ホストの公開状態の補足。改行なしの短い表示だけを受け、既知の項目だけを残す。 */
export function parsePagePublication(value: unknown): EditorPagePublication {
  const line = (text: unknown, maximum: number) => typeof text === "string" && text.trim() !== "" && text.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ページ一覧の公開状態の補足が正しくありません。");
  const { label, description } = value as Record<string, unknown>;
  if (!line(label, 40) || !line(description, 300)) throw new Error("ページ一覧の公開状態の補足が正しくありません。");
  return { label: label as string, description: description as string };
}

function structuredDataPresets(value: unknown): EditorStructuredDataPreset[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("構造化データの種類を確認できません。");
  const presets = value.map((item: unknown, index): EditorStructuredDataPreset => {
    const source = record(item, `structuredData[${index}]`);
    return { id: identifier(source.id, `structuredData[${index}].id`), label: line(source.label, `structuredData[${index}].label`, 80),
      ...(source.description === undefined ? {} : { description: line(source.description, `structuredData[${index}].description`, 200, true) }) };
  });
  if (new Set(presets.map((preset) => preset.id)).size !== presets.length) throw new Error("構造化データの種類が重複しています。");
  return presets;
}

function changeForProject(change: EditorPageChange, site: EditorSite): EditorPageChange {
  const normalized = normalizePageChange(change);
  if (!normalized) throw new Error("ページ変更の要求が正しくありません。");
  const siteId = normalized.action === "create" ? normalized.siteId : normalized.action === "duplicate" ? normalized.source.siteId : normalized.target.siteId;
  if (siteId !== site.id) throw new Error("プロジェクトのサイトと編集対象が一致しません。");
  return normalized;
}

function checkedPlan(plan: EditorReleasePlan, request: EditorReleaseRequest, site: EditorSite): EditorReleasePlan {
  const copy: EditorReleasePlan = {
    ...releaseRequest(plan, targetForProject(plan.target, site)),
    confirmationToken: plan.confirmationToken,
    domain: plan.domain,
    changes: plan.changes.map((change) => ({ path: change.path, before: change.before, after: change.after })),
    ...(plan.url === undefined ? {} : { url: plan.url }),
    ...(plan.affected === undefined ? {} : { affected: Array.isArray(plan.affected) ? plan.affected.map((item) => item && typeof item === "object"
      ? { kind: item.kind, name: item.name, ...(item.detail === undefined ? {} : { detail: item.detail }) } : item) : plan.affected })
  };
  validateReleasePlan(copy, request, site);
  return copy;
}

function releaseSetItemsForProject(value: unknown, site: EditorSite): EditingPageReleaseSetItem[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 50) throw new Error("公開変更セットの対象件数が正しくありません。");
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const source = record(raw, `items[${index}]`), target = targetForProject(record(source.target, `items[${index}].target`) as EditorTarget, site);
    const expectedVersion = releaseValue(source.expectedVersion, `items[${index}].expectedVersion`, 512), key = `${target.pageId}\u0000${target.locale}`;
    if (seen.has(key)) throw new Error("公開変更セットに同じページが重複しています。");
    seen.add(key);
    return { target, expectedVersion,
      ...(source.componentsVersion === undefined ? {} : { componentsVersion: releaseValue(source.componentsVersion, `items[${index}].componentsVersion`, 512) }),
      ...(source.presentationVersion === undefined ? {} : { presentationVersion: releaseValue(source.presentationVersion, `items[${index}].presentationVersion`, 512) }) };
  });
}

function sameReleaseSetItems(left: readonly EditingPageReleaseSetItem[], right: readonly EditingPageReleaseSetItem[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return !!other && item.target.siteId === other.target.siteId && item.target.pageId === other.target.pageId && item.target.locale === other.target.locale
      && item.expectedVersion === other.expectedVersion && item.componentsVersion === other.componentsVersion && item.presentationVersion === other.presentationVersion;
  });
}

function checkedReleaseSetPlan(value: unknown, expectedItems: readonly EditingPageReleaseSetItem[], site: EditorSite): EditingPageReleaseSetPlan {
  const source = record(value, "releaseSetPlan"), operationId = releaseValue(source.operationId, "operationId", 80);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(operationId)
    || source.siteId !== site.id || typeof source.confirmationToken !== "string" || !source.confirmationToken || source.confirmationToken.length > 512
    || typeof source.domain !== "string" || !site.domains.includes(source.domain)) throw new Error("公開変更セットの確認情報が正しくありません。");
  let domain: URL;
  try { domain = new URL(source.domain); } catch { throw new Error("公開変更セットの公開先が正しくありません。"); }
  if (domain.protocol !== "https:" || domain.origin !== source.domain || domain.username || domain.password || domain.search || domain.hash) throw new Error("公開変更セットの公開先が正しくありません。");
  const items = releaseSetItemsForProject(source.items, site);
  if (!sameReleaseSetItems(items, expectedItems)) throw new Error("公開変更セットの対象または版が一致しません。");
  return { siteId: site.id, operationId, confirmationToken: source.confirmationToken, domain: source.domain, items };
}

function checkedReleaseSetResult(value: unknown, site: EditorSite, operationId: string, expectedItems?: readonly EditingPageReleaseSetItem[]): EditingPageReleaseSetApplyResult {
  const source = record(value, "releaseSetResult");
  if (source.status === "conflict" || source.status === "invalid" || source.status === "not_found" || source.status === "duplicate") return { status: source.status };
  if ((source.status !== "completed" && source.status !== "publishing") || source.operationId !== operationId || !Array.isArray(source.items)
    || source.items.length < 2 || source.items.length > 50 || expectedItems && source.items.length !== expectedItems.length) throw new Error("公開変更セットの結果が正しくありません。");
  const seen = new Set<string>(), items = source.items.map((raw, index) => {
    const item = record(raw, `items[${index}]`), target = targetForProject(record(item.target, `items[${index}].target`) as EditorTarget, site);
    const key = `${target.pageId}\u0000${target.locale}`, expected = expectedItems?.[index];
    if (seen.has(key) || expected && (target.pageId !== expected.target.pageId || target.locale !== expected.target.locale)) throw new Error("公開変更セットの結果対象が一致しません。");
    seen.add(key);
    if (item.status === "released") return { target, status: "released" as const, version: releaseValue(item.version, `items[${index}].version`, 512) };
    if (item.status === "conflict") return { target, status: "conflict" as const };
    if (item.status === "pending") return { target, status: "pending" as const };
    throw new Error("公開変更セットの結果状態が正しくありません。");
  });
  if (source.status === "completed" && items.some((item) => item.status === "pending") || source.status === "publishing" && !items.some((item) => item.status === "pending")) throw new Error("公開変更セットの全体状態が項目状態と一致しません。");
  return { status: source.status, operationId, items };
}

/** 部品ライブラリと使用状況も Project の Site だけに限定する。 */
function componentsForProject(components: EditorComponentAdapter, site: EditorSite): EditorComponentAdapter {
  return {
    ...(components.nodeNames === true ? { nodeNames: true as const } : {}),
    async readLibrary(siteId, signal) {
      if (siteId !== site.id) throw new Error("プロジェクト外のサイトは参照できません。");
      const snapshot = structuredClone(await components.readLibrary(site.id, signal));
      assertLibrarySite(snapshot.library, site);
      return snapshot;
    },
    async saveLibrary(request, signal) {
      if (request.siteId !== site.id) throw new Error("プロジェクト外のサイトには保存できません。");
      const library = structuredClone(request.library);
      assertLibrarySite(library, site);
      return components.saveLibrary({ siteId: site.id, library, expectedVersion: request.expectedVersion, ...(request.trigger === "autosave" ? { trigger: "autosave" as const } : {}) }, signal);
    },
    async listUsage(siteId, signal) {
      if (siteId !== site.id) throw new Error("プロジェクト外のサイトは参照できません。");
      const usage = structuredClone(await components.listUsage(site.id, signal));
      if (usage.some((entry) => entry.target.siteId !== site.id)) throw new Error("使用状況に別サイトの項目が含まれています。");
      return usage;
    }
  };
}

function localizationForProject(localization: EditorLocalizationAdapter, site: EditorSite): EditorLocalizationAdapter {
  const command = (request: EditorLocalizationCommand): EditorLocalizationCommand => {
    const target = targetForProject(request.target, site), common = { target, expectedSourceVersion: request.expectedSourceVersion, expectedVersion: request.expectedVersion, expectedOverlayVersion: request.expectedOverlayVersion };
    if (request.action === "request-translation") return { action: request.action, ...common };
    if (request.action === "adopt-candidate") return { action: request.action, ...common, unitId: request.unitId, candidateVersion: request.candidateVersion };
    if (request.action === "set-value") return { action: request.action, ...common, unitId: request.unitId, value: structuredClone(request.value), sourceFingerprint: request.sourceFingerprint, expectedEntryVersion: request.expectedEntryVersion };
    return { action: request.action, ...common, unitId: request.unitId };
  };
  return {
    ...(localization.requestPageTranslation === false ? { requestPageTranslation: false as const } : {}),
    ...(localization.sourceDocumentLocale ? { sourceDocumentLocale: (siteId: string) => siteId === site.id ? localization.sourceDocumentLocale!(site.id) : undefined } : {}),
    async readSite(siteId, signal) {
      if (siteId !== site.id) throw new Error("プロジェクト外のサイトは参照できません。");
      const snapshot = structuredClone(await localization.readSite(site.id, signal));
      if (record(snapshot.config, "localization.config").siteId !== site.id || snapshot.pages.some((page) => page.siteId !== site.id)) throw new Error("多言語設定に別サイトの内容が含まれています。");
      return snapshot;
    },
    async readPage(target, signal) {
      const checked = targetForProject(target, site), snapshot = structuredClone(await localization.readPage(checked, signal));
      const source = record(snapshot.sourceDocument, "localization.sourceDocument");
      if (source.siteId !== site.id || source.pageId !== checked.pageId) throw new Error("多言語原文の対象が一致しません。");
      return snapshot;
    },
    async command(request, signal) { return localization.command(command(request), signal); },
    ...(localization.requestSiteTranslation ? { async requestSiteTranslation(request, signal) {
      if (request.siteId !== site.id) throw new Error("プロジェクト外のサイトは翻訳できません。");
      return localization.requestSiteTranslation!({ siteId: site.id, targetLocale: request.targetLocale, expectedVersion: request.expectedVersion }, signal);
    } } : {}),
    ...(localization.readRelease ? { async readRelease(request, signal) {
      if (request.siteId !== site.id || request.locale !== "ja" && request.locale !== "en") throw new Error("プロジェクト外の言語版は参照できません。");
      return parseEditorLocaleReleaseState(structuredClone(await localization.readRelease!({ siteId: site.id, locale: request.locale }, signal)), site.id, request.locale);
    } } : {}),
    ...(localization.prepareRelease ? { async prepareRelease(request, signal) {
      const checked = localeReleasePrepareRequest(request, site);
      return parseEditorLocaleReleasePlan(structuredClone(await localization.prepareRelease!(checked, signal)), checked, site.domains);
    } } : {}),
    ...(localization.applyRelease ? { async applyRelease(request, signal) {
      const checked = localeReleaseApplyRequest(request, site);
      return parseEditorLocaleReleaseApplyResult(structuredClone(await localization.applyRelease!(checked, signal)), { siteId: checked.siteId, locale: checked.locale, prepared: { releaseId: checked.preparedReleaseId, version: checked.preparedVersion } });
    } } : {}),
    ...(localization.rollbackRelease ? { async rollbackRelease(request, signal) {
      const checked = localeReleaseApplyRequest(request, site);
      return parseEditorLocaleReleaseApplyResult(structuredClone(await localization.rollbackRelease!(checked, signal)), { siteId: checked.siteId, locale: checked.locale, prepared: { releaseId: checked.preparedReleaseId, version: checked.preparedVersion } });
    } } : {})
  };
}

/**
 * EditorAdapter を Project の唯一の Site に限定する。これは認可機構ではないため、
 * 元 adapter は各呼出しで認証・サイト権限・永続化を検証しなければならない。
 */
export function createProjectEditorAdapter(adapter: EditorAdapter, projectInput: Project): EditorAdapter {
  const project = parseProject(projectInput);
  const site: EditorSite = { id: project.site.id, name: project.site.name, domains: [...project.site.domains] };
  return {
    async listSites(signal) {
      const sites = await adapter.listSites(signal);
      const matched = sites.find((candidate) => candidate.id === site.id);
      if (!matched || !sameSite(matched, site)) throw new Error("プロジェクトのサイト情報を確認できません。");
      return [{ id: site.id, name: site.name, domains: [...site.domains], ...(matched.structuredData === undefined ? {} : { structuredData: structuredDataPresets(matched.structuredData) }), ...(matched.externalFrameSources === undefined ? {} : { externalFrameSources: siteFrameSources(matched.externalFrameSources, site.domains) }) }];
    },
    async listPages(siteId, signal) {
      if (siteId !== site.id) throw new Error("プロジェクト外のサイトは参照できません。");
      const pages = await adapter.listPages(site.id, signal);
      if (pages.some((page) => page.siteId !== site.id)) throw new Error("ページ一覧に別サイトの項目が含まれています。");
      return pages.map(pageEntry);
    },
    ...(adapter.listFormCompletionPages ? {
      async listFormCompletionPages(target, signal) {
        const checked = targetForProject(target, site);
        const pages = await adapter.listFormCompletionPages!(checked, signal);
        if (pages.some((page) => page.siteId !== site.id)) throw new Error("完了ページ候補に別サイトの項目が含まれています。");
        return pages.map(pageEntry);
      }
    } satisfies Pick<EditorAdapter, "listFormCompletionPages"> : {}),
    async readDocument(target, signal) {
      const checkedTarget = targetForProject(target, site);
      const snapshot = structuredClone(await adapter.readDocument(checkedTarget, signal));
      assertDocumentTarget(snapshot.document, checkedTarget);
      assertPresentationTarget(snapshot.presentation, checkedTarget);
      const { readOnly: rawReadOnly, ...rest } = snapshot, readOnly = parseEditorReadOnly(rawReadOnly);
      return { ...rest, ...(readOnly ? { readOnly } : {}) };
    },
    ...(adapter.discoverPageNodeNames ? {
      discoverPageNodeNames: (target, signal) => adapter.discoverPageNodeNames!(targetForProject(target, site), signal)
    } satisfies Pick<EditorAdapter, "discoverPageNodeNames"> : {}),
    ...(adapter.cmsBindings ? { cmsBindings: {
      async read(target, signal) {
        const result = await adapter.cmsBindings!.read(targetForProject(target, site), signal);
        if (result.schema.siteId !== site.id) throw new Error("CMS の対象サイトが一致しません。");
        return result;
      },
      async preview(request, signal) {
        const target = targetForProject(request.target, site);
        assertDocumentTarget(request.document, target);
        const result = await adapter.cmsBindings!.preview({ ...request, target }, signal);
        assertDocumentTarget(result, target);
        return result;
      }
    } } satisfies Pick<EditorAdapter, "cmsBindings"> : {}),
    async saveDraft(request, signal) {
      const target = targetForProject(request.target, site);
      const document = structuredClone(request.document);
      assertDocumentTarget(document, target);
      return adapter.saveDraft({ target, document, expectedVersion: request.expectedVersion, ...(request.presentationVersion === undefined ? {} : { presentationVersion: request.presentationVersion }), ...(request.trigger === "autosave" ? { trigger: "autosave" as const } : {}),
        ...(request.cmsBindings === undefined ? {} : { cmsBindings: structuredClone(request.cmsBindings) }),
        ...(request.localization ? { localization: { expectedSourceVersion: request.localization.expectedSourceVersion, expectedVersion: request.localization.expectedVersion,
          expectedOverlayVersion: request.localization.expectedOverlayVersion } } : {}) }, signal);
    },
    ...(adapter.applyOperations ? {
      async applyOperations(request, signal) {
        const target = targetForProject(request.target, site);
        const result = await adapter.applyOperations!({ ...structuredClone(request), target }, signal);
        if (result.status === "applied") assertDocumentTarget(result.document, target);
        return structuredClone(result);
      }
    } satisfies Pick<EditorAdapter, "applyOperations"> : {}),
    async prepareRelease(request, signal) {
      const checked = releaseRequest(request, targetForProject(request.target, site));
      const plan = await adapter.prepareRelease(checked, signal);
      return checkedPlan(plan, checked, site);
    },
    async release(request, signal) {
      const target = targetForProject(request.target, site);
      const checked = checkedPlan(request, releaseRequest(request, target), site);
      const result = await adapter.release(checked, signal);
      if (result.status === "released") {
        const snapshot = structuredClone(result.snapshot);
        assertDocumentTarget(snapshot.document, target);
        assertPresentationTarget(snapshot.presentation, target);
        const { readOnly: rawReadOnly, ...rest } = snapshot, readOnly = parseEditorReadOnly(rawReadOnly);
        return { status: "released", snapshot: { ...rest, ...(readOnly ? { readOnly } : {}) } };
      }
      return result;
    },
    ...(adapter.prepareReleaseSet && adapter.releaseSet && adapter.releaseSetStatus ? {
      async prepareReleaseSet(items, signal) {
        const checked = releaseSetItemsForProject(items, site);
        return checkedReleaseSetPlan(structuredClone(await adapter.prepareReleaseSet!(checked, signal)), checked, site);
      },
      async releaseSet(plan, signal) {
        const items = releaseSetItemsForProject(plan.items, site), checked = checkedReleaseSetPlan(plan, items, site);
        return checkedReleaseSetResult(structuredClone(await adapter.releaseSet!(checked, signal)), site, checked.operationId, items);
      },
      async releaseSetStatus(operationId, signal) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(operationId)) throw new Error("公開変更セットの操作IDが正しくありません。");
        const source = record(structuredClone(await adapter.releaseSetStatus!(operationId, signal)), "releaseSetStatus");
        if (source.operationId !== operationId || source.status !== "unknown" && source.status !== "received" && source.status !== "completed") throw new Error("公開変更セットの状態が正しくありません。");
        if (source.status === "unknown" || source.status === "received") return { status: source.status, operationId };
        if (!Number.isInteger(source.httpStatus) || Number(source.httpStatus) < 100 || Number(source.httpStatus) > 599) throw new Error("公開変更セットの状態が正しくありません。");
        if (source.httpStatus === 200) return { status: "completed", operationId, httpStatus: 200,
          result: checkedReleaseSetResult(source.result, site, operationId) };
        return { status: "completed", operationId, httpStatus: Number(source.httpStatus), result: structuredClone(source.result) };
      }
    } satisfies Pick<EditorAdapter, "prepareReleaseSet" | "releaseSet" | "releaseSetStatus"> : {}),
    ...(adapter.components ? { components: componentsForProject(adapter.components, site) } : {}),
    ...(adapter.localization ? { localization: localizationForProject(adapter.localization, site) } : {}),
    ...(adapter.pagePathEditable === undefined ? {} : { pagePathEditable: adapter.pagePathEditable }),
    ...(adapter.pageChangeActions ? { pageChangeActions: [...adapter.pageChangeActions] } : {}),
    ...(adapter.preparePageChange ? {
      async preparePageChange(change, signal) {
        const checked = changeForProject(change, site);
        return validatePageChangePlan(structuredClone(await adapter.preparePageChange!(checked, signal)), checked, site);
      }
    } satisfies Pick<EditorAdapter, "preparePageChange"> : {}),
    ...(adapter.applyPageChange ? {
      async applyPageChange(plan, signal) {
        const checked = validatePageChangePlan(plan, changeForProject(plan.change, site), site);
        const result = await adapter.applyPageChange!(checked, signal);
        if (result.status === "conflict") return { status: "conflict" };
        if (result.status !== "applied" || !result.page || result.page.siteId !== site.id) throw new Error("ページ変更の結果が一致しません。");
        return { status: "applied", page: pageEntry(result.page) };
      }
    } satisfies Pick<EditorAdapter, "applyPageChange"> : {}),
    ...(adapter.siteStyleCapabilities ? { siteStyleCapabilities: adapter.siteStyleCapabilities } : {}),
    ...(adapter.siteSettingsMetadataEditable === undefined ? {} : { siteSettingsMetadataEditable: adapter.siteSettingsMetadataEditable }),
    ...(adapter.breakpointSettings ? { breakpointSettings: {
      async read(siteId, signal) {
        if (siteId !== site.id) throw new Error("プロジェクト外のサイトは参照できません。");
        const snapshot = await adapter.breakpointSettings!.read(site.id, signal);
        return { settings: parseBreakpointSettings(structuredClone(snapshot.settings)), version: line(snapshot.version, "breakpointSettings.version", 512) };
      },
      async save(request, signal) {
        if (request.siteId !== site.id) throw new Error("プロジェクト外のサイトには保存できません。");
        const settings = parseBreakpointSettings(structuredClone(request.settings));
        const expectedVersion = line(request.expectedVersion, "breakpointSettings.expectedVersion", 512);
        const result = await adapter.breakpointSettings!.save({ siteId: site.id, settings, expectedVersion }, signal);
        if (result.status === "conflict") return { status: "conflict" as const };
        if (result.status !== "saved") throw new Error("ブレークポイント設定の保存結果が正しくありません。");
        return { status: "saved" as const, version: line(result.version, "breakpointSettings.version", 512) };
      }
    } } : {}),
    ...(adapter.responsiveProposal ? { responsiveProposal: {
      async propose(request, signal) {
        const target = targetForProject(request.target, site), document = structuredClone(request.document);
        assertDocumentTarget(document, target);
        if (request.fingerprint !== fingerprint(document)) throw new Error("レスポンシブ提案の文書が一致しません。");
        const scope = request.scope?.type === "page" ? { type: "page" as const }
          : request.scope?.type === "node" && typeof request.scope.nodeId === "string" ? { type: "node" as const, nodeId: request.scope.nodeId }
            : null;
        if (!scope || !Array.isArray(request.breakpoints) || request.breakpoints.length > 12 || request.breakpoints.some((width) => !Number.isInteger(width))) throw new Error("レスポンシブ提案の範囲が正しくありません。");
        return structuredClone(await adapter.responsiveProposal!.propose({ target, document, fingerprint: request.fingerprint, scope, breakpoints: [...request.breakpoints] }, signal));
      }
    } } : {}),
    ...(adapter.readSiteSettings ? {
      async readSiteSettings(siteId, signal) {
        if (siteId !== site.id) throw new Error("プロジェクト外のサイトは参照できません。");
        const snapshot = await adapter.readSiteSettings!(site.id, signal);
        return { settings: structuredClone(snapshot.settings), version: snapshot.version };
      }
    } satisfies Pick<EditorAdapter, "readSiteSettings"> : {}),
    ...(adapter.saveSiteSettings ? {
      async saveSiteSettings(request, signal) {
        if (request.siteId !== site.id) throw new Error("プロジェクト外のサイトは変更できません。");
        if (request.previousStyles !== undefined) keys(record(request.previousStyles, "$.previousStyles"), ["tokens", "textStyles"], "$.previousStyles");
        return adapter.saveSiteSettings!({ siteId: site.id, settings: parseSiteSettings(request.settings), expectedVersion: request.expectedVersion, ...(request.previousStyles === undefined ? {} : { previousStyles: parseSiteStyles(request.previousStyles) }) }, signal);
      }
    } satisfies Pick<EditorAdapter, "saveSiteSettings"> : {}),
    ...(adapter.listRevisions ? {
      async listRevisions(request, signal) {
        const target = targetForProject(request.target, site);
        if (request.cursor !== undefined && (typeof request.cursor !== "string" || request.cursor.length > 500)) throw new Error("版履歴の続きを確認できません。");
        return parseRevisionPage(structuredClone(await adapter.listRevisions!({ target, ...(request.cursor === undefined ? {} : { cursor: request.cursor }) }, signal)));
      }
    } satisfies Pick<EditorAdapter, "listRevisions"> : {}),
    ...(adapter.readRevision ? {
      async readRevision(request, signal) {
        const target = targetForProject(request.target, site);
        if (typeof request.id !== "string" || !request.id || request.id.length > 200) throw new Error("版を確認できません。");
        const result = structuredClone(await adapter.readRevision!({ target, id: request.id }, signal));
        assertDocumentTarget(result?.document, target);
        assertPresentationTarget(result?.presentation, target);
        return { document: result.document, ...(result.siteStyles === undefined ? {} : { siteStyles: result.siteStyles }), ...(result.presentation === undefined ? {} : { presentation: result.presentation }) };
      }
    } satisfies Pick<EditorAdapter, "readRevision"> : {}),
    ...(adapter.createSnapshot ? {
      async createSnapshot(request, signal) {
        const target = targetForProject(request.target, site);
        const result = await adapter.createSnapshot!({ target, expectedVersion: request.expectedVersion, label: request.label }, signal);
        if (result.status === "conflict") return { status: "conflict" };
        if (result.status !== "saved") throw new Error("スナップショットの結果が一致しません。");
        return { status: "saved", entry: parseRevisionEntry(structuredClone(result.entry)) };
      }
    } satisfies Pick<EditorAdapter, "createSnapshot"> : {})
  };
}
