import { useMemo } from "react";
import { StudioPageEditor } from "./editor-performance.js";
import { parsePageDocument } from "../src/core.js";
import { cmsId, parseCmsSchema } from "../src/cms-v2-schema.js";
import { parseCmsPageBindings } from "../src/cms-page-bindings.js";
import { createProjectEditorAdapter } from "../src/project-editor-adapter.js";
import { createBrowserRecoveryStore, parseRevisionPage } from "../src/history.js";
import type {
  EditorAdapter, EditorPage, EditorPageChange, EditorPageChangePlan, EditorReleasePlan,
  EditorSaveResult, EditorSite, EditorSnapshot, EditorTarget
} from "../src/editor-types.js";
import type { Project } from "../src/projects.js";
import { managedBlockContracts } from "./managed-embed-contract.js";
import { managedEditorBlocks } from "./managed-embed-editor.js";
import { isSafeHttpsOrigin } from "../src/validation-utils.js";

const VERSION = /^[^\u0000-\u001f\u007f]{1,200}$/u;

class ManagedApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
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
    throw new ManagedApiError(response.status, code);
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
type Catalog = { readonly sites: readonly EditorSite[]; readonly pages: readonly EditorPage[] };
function catalog(value: unknown): Catalog {
  const source = record(value);
  if (!Array.isArray(source.sites) || source.sites.length !== 1 || !Array.isArray(source.pages) || source.pages.length > 500) throw new Error("ページ一覧が正しくありません。");
  const siteSource = record(source.sites[0]), domains = siteSource.domains;
  if (typeof siteSource.id !== "string" || typeof siteSource.name !== "string" || !Array.isArray(domains) || domains.length < 1 || domains.length > 2
    || domains.some((domain) => !isSafeHttpsOrigin(domain)) || new Set(domains).size !== domains.length) throw new Error("サイト情報が正しくありません。");
  return { sites: [{ id: siteSource.id, name: siteSource.name, domains: [...domains] }], pages: source.pages.map(page) };
}
function snapshot(value: unknown, checkedTarget: EditorTarget): EditorSnapshot {
  const source = record(value), document = parsePageDocument(source.document, managedBlockContracts);
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
  const refresh = async (signal: AbortSignal) => { current = catalog(await api(`${base}/catalog`, "GET", undefined, signal)); return current; };
  const conflict = async <T,>(run: () => Promise<T>): Promise<T | { status: "conflict" }> => {
    try { return await run(); } catch (error) { if (error instanceof ManagedApiError && error.status === 409) return { status: "conflict" }; throw error; }
  };
  return {
    listSites: async (signal) => (await refresh(signal)).sites,
    listPages: async (siteId, signal) => {
      if (siteId !== project.site.id) throw new Error("別サイトは参照できません。");
      return (await refresh(signal)).pages;
    },
    readDocument: async (input, signal) => snapshot(await api(`${base}/${encodeURIComponent(input.pageId)}`, "GET", undefined, signal), input),
    async listRevisions(request, signal) {
      if (request.target.siteId !== project.site.id) throw new Error("プロジェクト外の履歴は参照できません。");
      const query = request.cursor === undefined ? "" : `?cursor=${encodeURIComponent(request.cursor)}`;
      return parseRevisionPage(await api(`${base}/${encodeURIComponent(request.target.pageId)}/history${query}`, "GET", undefined, signal));
    },
    async readRevision(request, signal) {
      if (request.target.siteId !== project.site.id) throw new Error("プロジェクト外の履歴は参照できません。");
      const value = record(await api(`${base}/${encodeURIComponent(request.target.pageId)}/history-read`, "POST", { id: request.id }, signal));
      const document = parsePageDocument(value.document);
      if (document.siteId !== request.target.siteId || document.pageId !== request.target.pageId || document.locale !== request.target.locale) throw new Error("履歴の対象が一致しません。");
      return { document };
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
        const document = parsePageDocument(value.document, managedBlockContracts);
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
    prepareRelease: async (input, signal) => await api(`${base}/${encodeURIComponent(input.target.pageId)}/release-plan`, "POST", {
      target: input.target, expectedVersion: input.expectedVersion, action: input.action, ...(input.action === "rollback" ? { revision: input.revision } : {})
    }, signal) as EditorReleasePlan,
    release: (plan, signal) => conflict(async () => {
      const value = record(await api(`${base}/${encodeURIComponent(plan.target.pageId)}/release`, "POST", { expectedVersion: plan.expectedVersion, confirmationToken: plan.confirmationToken }, signal));
      if (value.status !== "released") throw new Error("公開結果が正しくありません。");
      return { status: "released" as const, snapshot: snapshot(value.snapshot, plan.target) };
    }),
    publishPageNow: (request, signal) => {
      if (request.target.siteId !== project.site.id || request.action === "restore" && (!Number.isSafeInteger(request.revision) || request.revision! < 1)
        || request.action === "publish" && request.revision !== undefined) throw new Error("公開対象または版が正しくありません。");
      return conflict(async () => {
        const value = record(await api(`${base}/${encodeURIComponent(request.target.pageId)}/publish`, "POST",
          { action: request.action, ...(request.action === "restore" ? { revision: request.revision } : {}) }, signal));
        if (value.status !== "released") throw new Error("公開結果が正しくありません。");
        return { status: "released" as const, snapshot: snapshot(value.snapshot, request.target) };
      });
    },
    pagePathEditable: true,
    pageChangeActions: ["create", "update", "visibility"],
    preparePageChange: async (change: EditorPageChange, signal: AbortSignal) => await api(`${base}/page-changes/prepare`, "POST", { change }, signal) as EditorPageChangePlan,
    applyPageChange: (plan: EditorPageChangePlan, signal: AbortSignal) => conflict(async () => {
      const value = record(await api(`${base}/page-changes/apply`, "POST", { change: plan.change, confirmationToken: plan.confirmationToken }, signal));
      if (value.status !== "applied") throw new Error("ページ操作の結果が正しくありません。");
      return { status: "applied" as const, page: page(value.page) };
    })
  };
}

export function ManagedEditor({ project, actorId }: { readonly project: Project; readonly actorId: string }) {
  const adapter = useMemo(() => createProjectEditorAdapter(createManagedEditorAdapter({ sites: [{ id: project.site.id, name: project.site.name, domains: project.site.domains }], pages: [] }, project), project), [project]);
  const recovery = useMemo(() => createBrowserRecoveryStore({ scope: actorId }), [actorId]);
  const base = `/api/projects/${encodeURIComponent(project.id)}/sites/${encodeURIComponent(project.site.id)}/editor`;
  const blocks = useMemo(() => managedEditorBlocks(base), [base]);
  return <main className="studio-editor studio-managed-editor">
    <StudioPageEditor adapter={adapter} blocks={blocks} enableUrlEmbeds autosave recovery={recovery} toolbarStart={<a href={`/projects/${encodeURIComponent(project.id)}/sites/${encodeURIComponent(project.site.id)}`} aria-label="ダッシュボードに戻る" title="ダッシュボードに戻る">←</a>} />
  </main>;
}
