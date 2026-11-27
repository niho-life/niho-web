"use client";

import { useEffect, useRef, useState } from "react";
import type { EditingPageReleaseSetApplyResult, EditingPageReleaseSetItem, EditingPageReleaseSetPlan, EditingPageReleaseSetStatus } from "./editing-api.js";
import { Dialog } from "./editor-dialog.js";
import { validateReleasePlan } from "./editor-model.js";
import type { EditorAdapter, EditorPage, EditorReleasePlan, EditorReleaseRequest, EditorSite } from "./editor-types.js";

type Preview = { page: EditorPage; plan: EditorReleasePlan };
type Completed = Exclude<EditingPageReleaseSetApplyResult, { status: "conflict" | "invalid" | "not_found" | "duplicate" | "publication_in_progress" | "migration_in_progress" }>;
type ReleaseSetAdapter = Pick<EditorAdapter, "readDocument" | "prepareRelease" | "prepareReleaseSet" | "releaseSet" | "releaseSetStatus">;

function targetKey(page: EditorPage): string { return `${page.siteId}\u0000${page.pageId}\u0000${page.locale}`; }
function errorStatus(error: unknown): number | undefined { return error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : undefined; }
function presentationVersion(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("表示設定の版を確認できません。");
  const version = (value as Record<string, unknown>).version;
  if (typeof version !== "string" || !version || version.length > 512) throw new Error("表示設定の版を確認できません。");
  return version;
}
function checkedReleaseSetPlan(value: unknown, expectedItems: readonly EditingPageReleaseSetItem[], site: EditorSite, sitePublicationEpoch?: string): EditingPageReleaseSetPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("公開変更セットの確認情報が正しくありません。");
  if (expectedItems.some((item) => (item.stylesVersion === undefined) !== (sitePublicationEpoch === undefined))) throw new Error("サイト共通スタイルの公開版を確認できません。");
  const source = value as Record<string, unknown>;
  const operationId = source.operationId;
  if (source.siteId !== site.id || typeof operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(operationId)
    || typeof source.confirmationToken !== "string" || !source.confirmationToken || source.confirmationToken.length > 512
    || typeof source.domain !== "string" || !site.domains.includes(source.domain)) throw new Error("公開変更セットの確認情報が正しくありません。");
  let domain: URL;
  try { domain = new URL(source.domain); } catch { throw new Error("公開変更セットの公開先が正しくありません。"); }
  if (domain.protocol !== "https:" || domain.origin !== source.domain || domain.username || domain.password || domain.search || domain.hash)
    throw new Error("公開変更セットの公開先が正しくありません。");
  if (expectedItems.length < 2 || expectedItems.length > 50 || !Array.isArray(source.items) || source.items.length !== expectedItems.length)
    throw new Error("公開変更セットの対象件数が一致しません。");
  for (const [index, raw] of source.items.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("公開変更セットの対象が正しくありません。");
    const item = raw as Record<string, unknown>, expected = expectedItems[index], target = item.target;
    if (!expected || !target || typeof target !== "object" || Array.isArray(target)) throw new Error("公開変更セットの対象が正しくありません。");
    const checked = target as Record<string, unknown>;
    if (checked.siteId !== expected.target.siteId || checked.pageId !== expected.target.pageId || checked.locale !== expected.target.locale
      || item.expectedVersion !== expected.expectedVersion || item.componentsVersion !== expected.componentsVersion || item.presentationVersion !== expected.presentationVersion
      || item.stylesVersion !== expected.stylesVersion)
      throw new Error("公開変更セットの対象または版が、確認した差分と一致しません。");
  }
  if ((sitePublicationEpoch === undefined) !== (source.sitePublicationEpoch === undefined)
    || sitePublicationEpoch !== undefined && source.sitePublicationEpoch !== sitePublicationEpoch
    || source.sitePublicationEpoch !== undefined && (typeof source.sitePublicationEpoch !== "string" || !source.sitePublicationEpoch || source.sitePublicationEpoch.length > 512)) {
    throw new Error("サイト共通スタイルの公開版が計画と一致しません。");
  }
  return { siteId: site.id, operationId, confirmationToken: source.confirmationToken, domain: source.domain,
    ...(source.sitePublicationEpoch === undefined ? {} : { sitePublicationEpoch: source.sitePublicationEpoch as string }), items: structuredClone(expectedItems) };
}
function resultFor(value: unknown, plan: EditingPageReleaseSetPlan): Completed | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if ((source.status !== "completed" && source.status !== "publishing") || source.operationId !== plan.operationId || !Array.isArray(source.items) || source.items.length !== plan.items.length) return null;
  const items: Completed["items"][number][] = [];
  for (const [index, raw] of source.items.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>, target = item.target;
    const expected = plan.items[index];
    if (!target || typeof target !== "object" || Array.isArray(target) || !expected) return null;
    const checked = target as Record<string, unknown>;
    if (checked.siteId !== expected.target.siteId || checked.pageId !== expected.target.pageId || checked.locale !== expected.target.locale) return null;
    if (item.status === "released" && typeof item.version === "string" && item.version.length > 0 && item.version.length <= 512) {
      items.push({ target: expected.target, status: "released", version: item.version });
    } else if (item.status === "conflict" || item.status === "pending") items.push({ target: expected.target, status: item.status });
    else return null;
  }
  const pending = items.some((item) => item.status === "pending");
  if (source.status === "publishing" !== pending) return null;
  return { status: source.status, operationId: plan.operationId, items };
}
function statusResult(status: EditingPageReleaseSetStatus, plan: EditingPageReleaseSetPlan): Completed | null {
  if (status.status !== "completed" || status.httpStatus !== 200) return null;
  return resultFor(status.result, plan);
}
function failureMessage(status: string): string {
  if (status === "conflict") return "公開計画後にページが更新されました。内容を読み直して、もう一度計画してください。";
  if (status === "duplicate") return "同じ操作IDが別の公開内容に使われています。新しい計画を作成してください。";
  if (status === "invalid") return "公開できないページが含まれています。対象ページを確認して計画し直してください。";
  if (status === "publication_in_progress") return "別の公開処理が進行中です。完了後に同じ計画を再試行してください。";
  if (status === "migration_in_progress") return "サイト共通スタイルの移行中です。完了後に計画し直してください。";
  return "公開変更セットを確認できませんでした。状態を確認してから再試行してください。";
}

/** 同じページ公開計画を先に読み、差分ありだけで作った変更セットを適用する。 */
export function PageReleaseSetDialog({ pages, site, adapter, componentsVersion, publishedStylesVersion, sitePublicationEpoch, close, completed }: {
  pages: readonly EditorPage[];
  site: EditorSite;
  adapter: ReleaseSetAdapter;
  componentsVersion?: string;
  publishedStylesVersion?: string;
  sitePublicationEpoch?: string;
  close: () => void;
  completed: () => void;
}) {
  const [phase, setPhase] = useState<"planning" | "review" | "applying" | "result" | "unknown" | "failed">("planning");
  const [previews, setPreviews] = useState<readonly Preview[]>([]), [plan, setPlan] = useState<EditingPageReleaseSetPlan | null>(null);
  const [result, setResult] = useState<Completed | null>(null), [message, setMessage] = useState("公開差分を確認しています…"), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), controller = useRef<AbortController | null>(null);
  const canClose = phase !== "applying" && phase !== "unknown" && !(result?.status === "publishing");

  async function prepare(signal: AbortSignal) {
    setPhase("planning"); setMessage("各ページの公開差分を確認しています…"); setPreviews([]); setPlan(null); setResult(null); setConfirmed(false);
    try {
      if (pages.length < 2 || pages.length > 50 || new Set(pages.map(targetKey)).size !== pages.length) throw new Error("対象は重複のない2〜50ページにしてください。");
      const changed: Preview[] = [];
      for (let offset = 0; offset < pages.length; offset += 5) {
        const group = pages.slice(offset, offset + 5);
        const values = await Promise.all(group.map(async (page) => {
          const snapshot = await adapter.readDocument(page, signal);
          if (snapshot.hasSavedDraft === false) throw new Error(`「${page.title}」は下書きがありません。編集して保存してから選んでください。`);
          const stylesVersion = publishedStylesVersion;
          if ((stylesVersion === undefined) !== (sitePublicationEpoch === undefined)) throw new Error("サイト共通スタイルの公開版を確認できません。ページとサイト設定を読み直してください。");
          const siteStyleReleaseContext = stylesVersion === undefined || sitePublicationEpoch === undefined ? {}
            : { siteStylesRevision: { stage: "published" as const, version: stylesVersion }, sitePublicationEpoch };
          const presentation = presentationVersion(snapshot.presentation);
          const request: EditorReleaseRequest = { target: page, expectedVersion: snapshot.version, action: "publish",
            ...(componentsVersion ? { componentsVersion } : {}), ...(presentation ? { presentationVersion: presentation } : {}),
            ...siteStyleReleaseContext };
          const value = await adapter.prepareRelease(request, signal);
          validateReleasePlan(value, request, site);
          return { page, plan: structuredClone(value) };
        }));
        changed.push(...values.filter(({ plan: item }) => item.changes.length > 0));
      }
      if (signal.aborted) return;
      setPreviews(changed);
      if (changed.length < 2) {
        setPhase("failed");
        setMessage(changed.length === 0 ? "選択したページに公開差分はありません。" : `差分があるページは「${changed[0]!.page.title}」の1件です。通常のページ公開を使ってください。`);
        return;
      }
      const items: EditingPageReleaseSetItem[] = changed.map(({ plan: item }) => ({ target: item.target, expectedVersion: item.expectedVersion,
        ...(item.componentsVersion === undefined ? {} : { componentsVersion: item.componentsVersion }), ...(item.presentationVersion === undefined ? {} : { presentationVersion: item.presentationVersion }),
        ...(item.siteStylesRevision === undefined ? {} : { stylesVersion: item.siteStylesRevision.version }) }));
      const prepared = checkedReleaseSetPlan(await adapter.prepareReleaseSet!(items, signal, sitePublicationEpoch), items, site, sitePublicationEpoch);
      if (signal.aborted) return;
      setPlan(prepared); setPhase("review"); setMessage("");
    } catch (error) {
      if (signal.aborted) return;
      setPhase("failed"); setMessage(errorStatus(error) === 409 ? "ページの状態が変わりました。ページ一覧を読み直して、公開計画を作り直してください。" : error instanceof Error ? error.message : "公開差分を確認できませんでした。時間をおいて再試行してください。");
    }
  }
  useEffect(() => {
    const active = new AbortController(); controller.current = active;
    void prepare(active.signal);
    return () => { active.abort(); controller.current = null; };
  // The dialog owns one immutable selection; a new selection opens a new dialog.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function apply() {
    if (!plan || !confirmed || busy || !adapter.releaseSet) return;
    const active = new AbortController(); controller.current = active; setBusy(true); setPhase("applying"); setMessage("選択したページを公開しています…");
    try {
      const value = await adapter.releaseSet(plan, active.signal);
      if (active.signal.aborted) return;
      if (value.status === "conflict" || value.status === "invalid" || value.status === "not_found" || value.status === "duplicate") {
        setPlan(null); setPhase("failed"); setMessage(failureMessage(value.status)); return;
      }
      const checked = resultFor(value, plan);
      if (!checked) throw new Error("公開結果の対象が計画と一致しません。");
      setResult(checked); setPhase("result"); setMessage(checked.status === "publishing" ? "一部のページは処理待ちです。同じ計画を再試行するか、状態を確認してください。" : "公開結果をページごとに確認してください。");
      completed();
    } catch (error) {
      if (active.signal.aborted) return;
      setPhase("unknown"); setMessage(errorStatus(error) === 409 ? failureMessage("conflict") : "応答を受け取れませんでした。公開状態を照会し、同じ計画を再試行してください。");
    } finally { if (!active.signal.aborted) setBusy(false); }
  }

  async function checkStatus() {
    if (!plan || busy || !adapter.releaseSetStatus) return;
    const active = new AbortController(); controller.current = active; setBusy(true); setMessage("公開状態を確認しています…");
    try {
      const status = await adapter.releaseSetStatus(plan.operationId, active.signal);
      if (active.signal.aborted) return;
      const checked = statusResult(status, plan);
      if (checked) { setResult(checked); setPhase("result"); setMessage(checked.status === "publishing" ? "一部のページは処理待ちです。" : "公開結果をページごとに確認してください。"); completed(); }
      else if (status.status === "received") { setPhase("unknown"); setMessage("ホストが操作を受け付けて処理中です。少し待ってから状態を再確認してください。"); }
      else if (status.status === "unknown") { setPhase("unknown"); setMessage("操作状態がまだ記録されていません。同じ計画を再試行できます。"); }
      else { setPhase("failed"); setMessage("保存された公開結果を確認できません。新しい計画を作成してください。"); setPlan(null); }
    } catch {
      if (!active.signal.aborted) { setPhase("unknown"); setMessage("公開状態を確認できませんでした。再接続後にもう一度確認してください。"); }
    } finally { if (!active.signal.aborted) setBusy(false); }
  }

  const resultItems = result?.items ?? [];
  const closeDialog = () => { if (canClose) { controller.current?.abort(); close(); } };
  return <Dialog name="複数ページを公開" dismiss={closeDialog}>
    <div className="e-release-set-dialog">
      <header><h2>複数ページを公開</h2><button type="button" className="e-icon-button" aria-label="閉じる" disabled={!canClose} onClick={closeDialog}>×</button></header>
      {phase === "planning" && <p role="status">{message}</p>}
      {phase === "failed" && <p role="alert">{message}</p>}
      {phase === "review" && plan && <>
        <p>差分がある {previews.length} ページを一つの変更セットで公開します。公開先と対象・差分を確認してください。</p>
        <p>公開先</p><p className="e-domain">{plan.domain}</p>
        <ul className="e-release-set-list">{previews.map(({ page, plan: item }) => <li key={targetKey(page)}><details>
          <summary><strong>{page.title}</strong><span>{item.changes.length} 件の変更</span></summary>
          <ul>{item.changes.map((change, index) => <li key={`${change.path}:${index}`}><code>{change.path}</code><pre><span>{change.before || "（なし）"}</span><span aria-hidden="true"> → </span><span>{change.after || "（なし）"}</span></pre></li>)}</ul>
        </details></li>)}</ul>
        <p className="e-help">差分のないページは対象から除いています。各ページは順に反映され、競合や処理待ちはページごとに表示されます。</p>
        <label className="e-release-set-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />表示した {previews.length} ページの公開を確認しました。</label>
        <footer><button type="button" className="e-small" onClick={closeDialog}>キャンセル</button><button type="button" className="e-primary" disabled={!confirmed || busy} onClick={() => void apply()}>{busy ? "公開しています…" : `${previews.length} ページを公開`}</button></footer>
      </>}
      {(phase === "unknown" || phase === "applying") && <>
        <p role={phase === "unknown" ? "alert" : "status"}>{message}</p>
        <div className="e-release-set-actions"><button type="button" className="e-small" disabled={busy} onClick={() => void checkStatus()}>{busy ? "確認中…" : "状態を確認"}</button>
          {phase === "unknown" && <button type="button" className="e-small" disabled={busy || !plan} onClick={() => void apply()}>同じ計画を再試行</button>}</div>
      </>}
      {phase === "result" && result && <>
        <p role={result.status === "publishing" ? "status" : "status"}>{message}</p>
        <ul className="e-release-set-results">{resultItems.map((item) => {
          const page = pages.find((candidate) => candidate.pageId === item.target.pageId && candidate.locale === item.target.locale);
          const label = item.status === "released" ? "公開済み" : item.status === "conflict" ? "競合" : "処理待ち";
          return <li key={`${item.target.pageId}:${item.target.locale}`}><strong>{page?.title ?? item.target.pageId}</strong><span>{label}</span></li>;
        })}</ul>
        {result.status === "publishing" && <div className="e-release-set-actions"><button type="button" className="e-small" disabled={busy} onClick={() => void checkStatus()}>{busy ? "確認中…" : "状態を確認"}</button><button type="button" className="e-small" disabled={busy} onClick={() => void apply()}>未完了ページを再試行</button></div>}
        {result.status === "completed" && <footer><button type="button" className="e-primary" onClick={closeDialog}>ページ一覧に戻る</button></footer>}
      </>}
    </div>
  </Dialog>;
}
