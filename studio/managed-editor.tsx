import { useEffect, useMemo, useState } from "react";
import { StudioPageEditor } from "./editor-performance.js";
import { parseResolvedAssets } from "../src/assets.js";
import { parsePageDocument } from "../src/core.js";
import { cmsId, parseCmsSchema } from "../src/cms-v2-schema.js";
import { parseCmsPageBindings } from "../src/cms-page-bindings.js";
import { createProjectEditorAdapter } from "../src/project-editor-adapter.js";
import { createEditingApiSiteSettingsFacade, createPageEditingApiClient } from "../src/editing-client.js";
import { createBrowserRecoveryStore, parseRevisionPage } from "../src/history.js";
import type { SiteStyles } from "../src/site-styles.js";
import { EDITOR_RELEASE_WARNING_CODES } from "../src/editor-types.js";
import type {
  EditorAdapter, EditorPage, EditorPageChange, EditorReleaseWarning,
  EditorSaveResult, EditorSite, EditorSnapshot, EditorTarget
} from "../src/editor-types.js";
import { parseProjectSite, type Project } from "../src/projects.js";
import { managedBlockContracts } from "./managed-embed-contract.js";
import { managedEditorBlocks } from "./managed-embed-editor.js";

const VERSION = /^[^\u0000-\u001f\u007f]{1,200}$/u;

class ManagedApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly failedUrl?: string, readonly failureMessage?: string) { super(code); }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("編集APIの応答が正しくありません。");
  return value as Record<string, unknown>;
}
async function api(path: string, method: "GET" | "POST" | "PUT", body: Record<string, unknown> | undefined, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, {
    method, signal, cache: "no-store", credentials: "same-origin",
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw new ManagedApiError(503, "invalid_response");
  const value = await response.json() as unknown;
  if (!response.ok) {
    const source = record(value), code = typeof source.error === "string" ? source.error : "request_failed";
    throw new ManagedApiError(response.status, code, typeof source.failedUrl === "string" ? source.failedUrl : undefined,
      typeof source.message === "string" ? source.message : undefined);
  }
  return value;
}
function target(value: unknown): EditorTarget {
  const source = record(value);
  if (typeof source.siteId !== "string" || typeof source.pageId !== "string" || typeof source.locale !== "string") throw new Error("編集対象が正しくありません。");
  return { siteId: source.siteId, pageId: source.pageId, locale: source.locale };
}
function page(value: unknown): EditorPage {
  const source = record(value), checked = target(source);
  if (typeof source.title !== "string" || typeof source.path !== "string" || source.kind !== "page"
    || source.visibility !== "public" && source.visibility !== "private" || typeof source.published !== "boolean") throw new Error("ページ一覧が正しくありません。");
  return { ...checked, title: source.title, path: source.path, kind: "page", visibility: source.visibility, published: source.published };
}
type Catalog = { readonly sites: readonly EditorSite[]; readonly pages: readonly EditorPage[];
  readonly version?: string; readonly versions?: ReadonlyMap<string, string> };
const pageKey = (target: EditorTarget) => `${target.pageId}/${target.locale}`;
function catalog(value: unknown): Catalog {
  const source = record(value);
  if (!Array.isArray(source.sites) || source.sites.length !== 1 || !Array.isArray(source.pages) || source.pages.length > 500) throw new Error("ページ一覧が正しくありません。");
  const siteSource = record(source.sites[0]);
  const site = parseProjectSite({ id: siteSource.id, name: siteSource.name, domains: siteSource.domains }, "catalog.sites[0]");
  if (site.domains.length === 0) throw new Error("サイト情報が正しくありません。");
  if (typeof source.version !== "string" || !VERSION.test(source.version)) throw new Error("ページ一覧の版が正しくありません。");
  const versions = new Map<string, string>();
  const pages = source.pages.map((entry) => {
    const parsed = page(entry), { version } = record(entry);
    if (typeof version !== "string" || !VERSION.test(version)) throw new Error("ページの版が正しくありません。");
    versions.set(pageKey(parsed), version);
    return parsed;
  });
  return { sites: [site], version: source.version, pages, versions };
}
function snapshot(value: unknown, checkedTarget: EditorTarget, siteStyles?: SiteStyles): EditorSnapshot {
  const source = record(value), document = parsePageDocument(source.document, managedBlockContracts, siteStyles ? { siteStyles } : {});
  if (document.siteId !== checkedTarget.siteId || document.pageId !== checkedTarget.pageId || document.locale !== checkedTarget.locale || typeof source.version !== "string" || !VERSION.test(source.version)) throw new Error("ページ文書が正しくありません。");
  if (!Array.isArray(source.releases) || source.releases.length > 50 || source.releases.some((entry) => {
    const item = record(entry); return !Number.isSafeInteger(item.revision) || Number(item.revision) < 1 || typeof item.label !== "string";
  })) throw new Error("公開履歴が正しくありません。");
  return { document, version: source.version, hasSavedDraft: source.hasSavedDraft === true, releases: source.releases as { revision: number; label: string }[],
    ...(source.cmsBindings === undefined ? {} : { cmsBindings: source.cmsBindings === null ? null : parseCmsPageBindings(source.cmsBindings, checkedTarget) }) };
}

export function createManagedEditorAdapter(initial: Catalog, project: Project): EditorAdapter {
  let current = initial;
  const base = `/api/projects/${encodeURIComponent(project.id)}/sites/${encodeURIComponent(project.site.id)}/editor`;
  const editingApi = createPageEditingApiClient({ origin: typeof window === "undefined" ? "https://studio.invalid" : window.location.origin,
    siteId: project.site.id, basePath: "/api/edit/v1", credentials: "same-origin", preferLegacyDiscovery: true });
  const siteSettings = createEditingApiSiteSettingsFacade(editingApi, project.site.id, { title: project.site.name, locale: "ja" });
  const readDraftStyles = async (siteId: string, signal: AbortSignal): Promise<SiteStyles> => {
    if (siteId !== project.site.id) throw new Error("プロジェクト外のサイトは参照できません。");
    return (await editingApi.readSiteStyles(signal)).draft.styles;
  };
  const refresh = async (signal: AbortSignal) => { current = catalog(await api(`${base}/catalog`, "GET", undefined, signal)); return current; };
  const conflict = async <T,>(run: () => Promise<T>): Promise<T | { status: "conflict" }> => {
    try { return await run(); } catch (error) { if (error instanceof ManagedApiError && error.status === 409) return { status: "conflict" }; throw error; }
  };
  return {
    listSites: async () => current.sites,
    listPages: async (siteId, signal) => {
      if (siteId !== project.site.id) throw new Error("別サイトは参照できません。");
      return (await refresh(signal)).pages;
    },
    readDocument: async (input, signal) => {
      const [value, siteStyles] = await Promise.all([
        api(`${base}/${encodeURIComponent(input.pageId)}`, "GET", undefined, signal), readDraftStyles(input.siteId, signal)
      ]);
      return snapshot(value, input, siteStyles);
    },
    async listRevisions(request, signal) {
      if (request.target.siteId !== project.site.id) throw new Error("プロジェクト外の履歴は参照できません。");
      const query = request.cursor === undefined ? "" : `?cursor=${encodeURIComponent(request.cursor)}`;
      return parseRevisionPage(await api(`${base}/${encodeURIComponent(request.target.pageId)}/history${query}`, "GET", undefined, signal));
    },
    async readRevision(request, signal) {
      if (request.target.siteId !== project.site.id) throw new Error("プロジェクト外の履歴は参照できません。");
      const value = record(await api(`${base}/${encodeURIComponent(request.target.pageId)}/history-read`, "POST", { id: request.id }, signal));
      const document = parsePageDocument(value.document, managedBlockContracts, { siteStyles: await readDraftStyles(request.target.siteId, signal) });
      if (document.siteId !== request.target.siteId || document.pageId !== request.target.pageId || document.locale !== request.target.locale) throw new Error("履歴の対象が一致しません。");
      return { document };
    },
    assetResolver: {
      async resolveAssets({ siteId, references }, signal) {
        if (siteId !== project.site.id) throw new Error("別サイトの素材は参照できません。");
        const value = record(await api(`/api/edit/v1/sites/${encodeURIComponent(siteId)}/operations/assets.resolve`, "POST", { references }, signal));
        return parseResolvedAssets(value.assets);
      }
    },
    cmsBindings: {
      async read(input, signal) {
        const value = record(await api(`${base}/${encodeURIComponent(input.pageId)}/cms-bindings`, "GET", undefined, signal));
        const schema = parseCmsSchema(value.schema);
        if (schema.siteId !== input.siteId || !Array.isArray(value.items) || value.items.length > 25) throw new Error("CMS の項目が正しくありません。");
        const items = value.items.map((raw) => {
          const item = record(raw);
          if (typeof item.label !== "string" || item.label.length > 500) throw new Error("CMS の項目名が正しくありません。");
          return { collectionId: cmsId(item.collectionId, "collectionId"), itemId: cmsId(item.itemId, "itemId"),
            revision: cmsId(item.revision, "revision"), label: item.label };
        });
        return { schema, items };
      },
      async preview(input, signal) {
        const path = `${base}/${encodeURIComponent(input.target.pageId)}`;
        const body = { expectedVersion: input.expectedVersion, document: input.document, cmsBindings: input.cmsBindings,
          collectionId: input.item.collectionId, itemId: input.item.itemId, revision: input.item.revision };
        const plan = record(await api(path + "/cms-preview-plan", "POST", body, signal));
        if (typeof plan.previewId !== "string" || !/^token_[a-f0-9]{32}$/u.test(plan.previewId)) throw new Error("プレビューを開始できません。");
        const value = record(await api(path + "/cms-preview", "POST", { ...body, previewId: plan.previewId }, signal));
        const document = parsePageDocument(value.document, managedBlockContracts, { siteStyles: await readDraftStyles(input.target.siteId, signal) });
        if (document.siteId !== input.target.siteId || document.pageId !== input.target.pageId || document.locale !== input.target.locale) throw new Error("プレビューの対象が一致しません。");
        return document;
      }
    },
    saveDraft: (input, signal) => conflict(async () => {
      const value = record(await api(`${base}/${encodeURIComponent(input.target.pageId)}/draft`, "PUT", { expectedVersion: input.expectedVersion, document: input.document,
        ...(input.cmsBindings === undefined ? {} : { cmsBindings: input.cmsBindings }) }, signal));
      if (value.status !== "saved" || typeof value.version !== "string" || !VERSION.test(value.version) || !Number.isSafeInteger(value.revision)) throw new Error("保存結果が正しくありません。");
      return { status: "saved", version: value.version, revision: Number(value.revision) } satisfies EditorSaveResult;
    }) as Promise<EditorSaveResult>,
    publishPageNow: (request, signal) => {
      if (request.target.siteId !== project.site.id || request.action === "restore" && (!Number.isSafeInteger(request.revision) || request.revision! < 1)
        || request.action === "publish" && request.revision !== undefined) throw new Error("公開対象または版が正しくありません。");
      return conflict(async () => {
        const value = record(await api(`${base}/${encodeURIComponent(request.target.pageId)}/publish`, "POST",
          { expectedVersion: request.expectedVersion, action: request.action, ...(request.action === "restore" ? { revision: request.revision } : {}) }, signal));
        if (value.status !== "released") throw new Error("公開結果が正しくありません。");
        let url: string | undefined;
        if (value.url !== undefined) {
          try {
            const publishedUrl = new URL(String(value.url));
            if (publishedUrl.protocol !== "https:" || publishedUrl.username || publishedUrl.password || String(value.url).length > 2048) throw new Error();
            url = publishedUrl.href;
          } catch { throw new Error("公開 URL が正しくありません。"); }
        }
        let warnings: EditorReleaseWarning[] | undefined;
        if (value.warnings !== undefined) {
          if (!Array.isArray(value.warnings) || value.warnings.length > 100 || value.warnings.some((warning) => {
            const item = record(warning);
            return typeof item.code !== "string" || !EDITOR_RELEASE_WARNING_CODES.includes(item.code as EditorReleaseWarning["code"])
              || typeof item.message !== "string" || item.message.length > 1000;
          })) throw new Error("公開警告が正しくありません。");
          warnings = value.warnings as EditorReleaseWarning[];
        }
        const siteStyles = await readDraftStyles(request.target.siteId, signal);
        const elapsedMs = typeof value.elapsedMs === "number" && Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0 ? value.elapsedMs : undefined;
        return { status: "released" as const, snapshot: snapshot(value.snapshot, request.target, siteStyles), ...(url ? { url } : {}),
          ...(warnings ? { warnings } : {}), ...(elapsedMs === undefined ? {} : { elapsedMs }) };
      }).catch((error: unknown) => {
        if (error instanceof ManagedApiError && error.failedUrl) return { status: "failed" as const, failedUrl: error.failedUrl,
          message: error.failureMessage ?? "ページの公開生成に失敗しました。" };
        throw error;
      });
    },
    pagePathEditable: true,
    pageChangeActions: ["create", "update", "visibility"],
    changePageNow: (change: EditorPageChange, signal: AbortSignal, pageVersion?: string) => conflict(async () => {
      if (change.action === "duplicate") throw new Error("このページ操作は利用できません。");
      const expectedVersion = change.action === "create" ? current.version : pageVersion ?? current.versions?.get(pageKey(change.target));
      if (!expectedVersion) return { status: "conflict" as const };
      const value = record(await api(`${base}/page-changes`, "POST", { expectedVersion, change }, signal));
      if (value.status !== "applied") throw new Error("ページ操作の結果が正しくありません。");
      return { status: "applied" as const, page: page(value.page) };
    }),
    ...siteSettings
  };
}

type PublicationChange = { readonly kind: "page"; readonly title: string; readonly path: string; readonly reason: string }
  | { readonly kind: "shared"; readonly label: string; readonly appliesToAllPages: true };
type PublicationHistoryEntry = { readonly releaseId: string; readonly createdAt: string; readonly actorName: string | null;
  readonly changedPaths: readonly string[] | null; readonly changedPathCount: number | null; readonly current: boolean };

function ManagedPublicationPanel({ siteId }: { readonly siteId: string }) {
  const [changes, setChanges] = useState<readonly PublicationChange[]>([]);
  const [version, setVersion] = useState("");
  const [history, setHistory] = useState<{ readonly currentReleaseId: string | null; readonly releases: readonly PublicationHistoryEntry[] }>({ currentReleaseId: null, releases: [] });
  const [message, setMessage] = useState("");
  const [publicationResult, setPublicationResult] = useState<{ readonly urls: readonly string[]; readonly elapsedMs: number;
    readonly warnings: readonly EditorReleaseWarning[]; readonly undoReleaseId: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const endpoint = `/api/edit/v1/sites/${encodeURIComponent(siteId)}/operations`;
  const refresh = async (signal: AbortSignal): Promise<{ readonly version: string; readonly changes: readonly PublicationChange[] }> => {
    const value = record(await api(`${endpoint}/site.publication-changes`, "GET", undefined, signal));
    if (typeof value.version !== "string" || !Array.isArray(value.changes) || value.changes.length > 503) throw new Error("未公開変更の一覧が正しくありません。");
    const next = value.changes.map((raw): PublicationChange => {
      const change = record(raw);
      if (change.kind === "page" && typeof change.title === "string" && typeof change.path === "string" && typeof change.reason === "string")
        return { kind: "page", title: change.title, path: change.path, reason: change.reason };
      if (change.kind === "shared" && typeof change.label === "string" && change.appliesToAllPages === true)
        return { kind: "shared", label: change.label, appliesToAllPages: true };
      throw new Error("未公開変更の一覧が正しくありません。");
    });
    setChanges(next);
    setVersion(value.version);
    return { version: value.version, changes: next };
  };
  const refreshHistory = async (signal: AbortSignal) => {
    const value = record(await api(`${endpoint}/site.publication-history`, "GET", undefined, signal));
    if (value.currentReleaseId !== null && typeof value.currentReleaseId !== "string"
      || !Array.isArray(value.releases) || value.releases.length > 50) throw new Error("公開履歴が正しくありません。");
    const releases = value.releases.map((raw): PublicationHistoryEntry => {
      const release = record(raw);
      if (typeof release.releaseId !== "string" || typeof release.createdAt !== "string"
        || !Number.isFinite(Date.parse(release.createdAt))
        || release.actorName !== null && typeof release.actorName !== "string"
        || release.changedPaths !== null && (!Array.isArray(release.changedPaths) || release.changedPaths.length > 100
          || release.changedPaths.some((path) => typeof path !== "string" || path.length > 512))
        || release.changedPathCount !== null && (!Number.isSafeInteger(release.changedPathCount) || Number(release.changedPathCount) < 0)
        || typeof release.current !== "boolean") throw new Error("公開履歴が正しくありません。");
      return { releaseId: release.releaseId, createdAt: release.createdAt, actorName: release.actorName,
        changedPaths: release.changedPaths as string[] | null, changedPathCount: release.changedPathCount as number | null, current: release.current };
    });
    const next = { currentReleaseId: value.currentReleaseId as string | null, releases };
    setHistory(next);
    return next;
  };
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([refresh(controller.signal), refreshHistory(controller.signal)])
      .catch(() => setMessage("未公開変更または公開履歴を読み込めませんでした。"));
    return () => controller.abort();
  }, [siteId]);
  const publish = async () => {
    if (busy) return;
    const startedAt = performance.now();
    setBusy(true); setMessage(""); setPublicationResult(null);
    const controller = new AbortController();
    try {
      const previousHistory = await refreshHistory(controller.signal);
      const pending = await refresh(controller.signal);
      if (!pending.changes.length) { setMessage("未公開の変更はありません。"); return; }
      const value = record(await api(`${endpoint}/site.publish`, "POST", { expectedVersion: pending.version, scope: "changed" }, controller.signal));
      if (value.status === "conflict") setMessage("変更が同時に更新されました。一覧を確認してください。");
      else if (value.status === "failed" && typeof value.failedUrl === "string" && typeof value.message === "string")
        setMessage(`${value.failedUrl} の生成に失敗しました。${value.message}`);
      else if (value.status === "released" && Array.isArray(value.urls) && value.urls.length <= 1000
        && value.urls.every((url) => typeof url === "string" && url.length <= 2048 && /^https:\/\//u.test(url))
        && Number.isSafeInteger(value.elapsedMs) && Number(value.elapsedMs) >= 0 && Number(value.elapsedMs) <= 600_000
        && Array.isArray(value.warnings) && value.warnings.length <= 100 && value.warnings.every((warning) => {
          if (!warning || typeof warning !== "object" || Array.isArray(warning)) return false;
          const entry = warning as Record<string, unknown>;
          return EDITOR_RELEASE_WARNING_CODES.includes(entry.code as EditorReleaseWarning["code"])
            && typeof entry.message === "string" && entry.message.length <= 1000;
        })) {
        const urls = value.urls as string[], warnings = value.warnings as EditorReleaseWarning[], elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
        setPublicationResult({ urls, elapsedMs, warnings, undoReleaseId: urls.length ? previousHistory.currentReleaseId : null });
        setMessage(`${urls.length} URLを公開しました（${elapsedMs} ms、SEO警告 ${warnings.length}件）。`);
      }
      else throw new Error("公開結果が正しくありません。");
      await refresh(controller.signal);
      await refreshHistory(controller.signal);
    } catch (error) {
      setMessage(error instanceof ManagedApiError && error.status === 409
        ? "変更が同時に更新されました。一覧を確認してください。"
        : "変更を公開できませんでした。時間をおいて再読込してください。");
      await refresh(controller.signal).catch(() => undefined);
    } finally { setBusy(false); }
  };
  const rollback = async (releaseId: string) => {
    if (busy || !history.currentReleaseId || releaseId === history.currentReleaseId) return;
    setBusy(true); setMessage("");
    const controller = new AbortController();
    try {
      const current = await refreshHistory(controller.signal);
      if (!current.currentReleaseId || current.currentReleaseId === releaseId) { setMessage("現在の公開版はすでに切り替わっています。"); return; }
      const result = record(await api(`${endpoint}/site.publication-rollback`, "POST",
        { expectedVersion: current.currentReleaseId, releaseId }, controller.signal));
      let rolledBack = false;
      if (result.status === "conflict") setMessage("公開版が同時に更新されました。履歴を確認してください。");
      else if (result.status === "rolled_back" && result.releaseId === releaseId) {
        rolledBack = true;
        setPublicationResult(null);
        setMessage("選んだ公開版に戻しました。");
      } else throw new Error("公開版を戻せませんでした。");
      const refreshed = await Promise.allSettled([refreshHistory(controller.signal), refresh(controller.signal)]);
      if (rolledBack && refreshed.some(({ status }) => status === "rejected")) {
        setMessage("選んだ公開版に戻しました。画面の再読み込みに失敗しました。再読込してください。");
      }
    } catch (error) {
      setMessage(error instanceof ManagedApiError && error.status === 409
        ? "公開版が同時に更新されました。履歴を確認してください。"
        : "公開版を戻せませんでした。時間をおいて再読込してください。");
      await refreshHistory(controller.signal).catch(() => undefined);
    } finally { setBusy(false); }
  };
  return <details className="studio-publication-panel" onToggle={(event) => {
      if (!event.currentTarget.open) return;
      const controller = new AbortController();
      setMessage("");
      void Promise.all([refresh(controller.signal), refreshHistory(controller.signal)])
        .catch(() => setMessage("未公開変更または公開履歴を読み込めませんでした。"));
    }}>
    <summary>未公開の変更 {changes.length}件</summary>
    {changes.length ? <ul>{changes.map((change, index) => <li key={`${change.kind}:${index}`}>
      {change.kind === "page" ? `${change.title} (${change.path})` : `${change.label}（全ページ）`}
    </li>)}</ul> : <p>未公開の変更はありません。</p>}
    {changes.length > 0 && <button className="studio-secondary" type="button" disabled={busy || !version} onClick={() => void publish()}>
      {busy ? "公開中…" : `変更をまとめて公開（${changes.length}件）`}
    </button>}
    {message && <p role="status">{message}</p>}
    {publicationResult && <details><summary>公開した URL と SEO 警告</summary>
      <ul>{publicationResult.urls.map((url) => <li key={url}><a href={url} target="_blank" rel="noreferrer">{url}</a></li>)}</ul>
      {publicationResult.warnings.length > 0 && <ul>{publicationResult.warnings.map((warning, index) => <li key={`${warning.code}:${index}`}>{warning.message}</li>)}</ul>}
      {publicationResult.undoReleaseId && <button className="studio-secondary" type="button" disabled={busy} onClick={() => void rollback(publicationResult.undoReleaseId!)}>元に戻す</button>}
    </details>}
    <details>
      <summary>公開履歴 {history.releases.length}件</summary>
      {history.releases.length ? <ol>{history.releases.map((release) => <li key={release.releaseId}>
        <p>{new Date(release.createdAt).toLocaleString("ja-JP")}・{release.actorName ?? "実行者未記録"}{release.current ? "・現在" : ""}</p>
        <p>{release.changedPathCount === null ? "変更 URL 未記録" : `変更 URL ${release.changedPathCount}件`}</p>
        {release.changedPaths?.length ? <ul>{release.changedPaths.map((path) => <li key={path}>{path}</li>)}</ul> : null}
        {release.changedPathCount !== null && release.changedPaths && release.changedPathCount > release.changedPaths.length
          ? <p>ほか {release.changedPathCount - release.changedPaths.length}件</p> : null}
        {!release.current && <button className="studio-secondary" type="button" disabled={busy || !history.currentReleaseId}
          onClick={() => void rollback(release.releaseId)}>{busy ? "処理中…" : "この版に戻す"}</button>}
      </li>)}</ol> : <p>公開履歴はありません。</p>}
    </details>
  </details>;
}

export function ManagedEditor({ project, actorId }: { readonly project: Project; readonly actorId: string }) {
  const adapter = useMemo(() => createProjectEditorAdapter(createManagedEditorAdapter({ sites: [{ id: project.site.id, name: project.site.name, domains: project.site.domains }], pages: [] }, project), project), [project]);
  const recovery = useMemo(() => createBrowserRecoveryStore({ scope: actorId }), [actorId]);
  const base = `/api/projects/${encodeURIComponent(project.id)}/sites/${encodeURIComponent(project.site.id)}/editor`;
  const blocks = useMemo(() => managedEditorBlocks(base), [base]);
  return <main className="studio-editor studio-managed-editor">
    <StudioPageEditor adapter={adapter} blocks={blocks} enableUrlEmbeds autosave recovery={recovery} toolbarStart={<>
      <a href={`/projects/${encodeURIComponent(project.id)}/sites/${encodeURIComponent(project.site.id)}`} aria-label="ダッシュボードに戻る" title="ダッシュボードに戻る">←</a>
      <ManagedPublicationPanel siteId={project.site.id} />
    </>} />
  </main>;
}
