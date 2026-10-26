"use client";

import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import { parseProject, type Project } from "./projects.js";
import { parseProjectDashboardResult, type ProjectDashboardAdapter, type ProjectDashboardResult, type ProjectMemberRole, type ProjectMemberSummary, type ProjectOverview, type ReadSection } from "./project-read-model.js";
import { dateLabel, PublicationBadge, ReadNotice, Timestamp, useProjectRead } from "./project-view-shared.js";
import { projectViewCss } from "./project-view-style.js";

export { parseProjectDashboardResult } from "./project-read-model.js";
export type { ProjectAnalytics, ProjectDashboardAdapter, ProjectDashboardResult, ProjectMemberRole, ProjectMemberSummary, ProjectOverview, ProjectTarget, ReadSection } from "./project-read-model.js";
/** ホストが接続したサイト機能（CMS・素材・翻訳など）。中身はホストが描く */
export type ProjectSiteView = { id: string; label: string; content: ReactNode };
export type ProjectDashboardProps = {
  project: Project;
  adapter: ProjectDashboardAdapter;
  onBackToProjects: () => void;
  onOpenEditor: (project: Project) => void;
  /** 設定の実装はホストが持つ。analyticsは実際の接続設定を開く。 */
  onOpenSettings: (project: Project, section: "site" | "analytics") => void;
  /** editor bridge未接続時は、ホストの説明surfaceを開ける正直なラベルにする。 */
  editorAction?: "enabled" | "pending";
  /**
   * ホストに設定画面がない場合は、設定操作を無効として表示する。
   * `settingsContent` を渡したホストではプロジェクト設定は常に開け、この値は解析の接続設定の操作にだけ効く。
   */
  settingsAction?: "enabled" | "disabled";
  /** プロジェクト設定を開いたときに Dashboard の中に出す中身（メンバーと招待など）。指定がなければ onOpenSettings を呼ぶ。 */
  settingsContent?: ReactNode;
  /** 左のメニューの「サイト機能」に並べるサイト機能。選ぶと Dashboard の本文の代わりに中身を出す。 */
  siteViews?: readonly ProjectSiteView[];
  /** 開いているサイト機能の id。null・未指定は Dashboard 側（ダッシュボード・メンバー・プロジェクト設定・アナリティクス）。URL と合わせるためホストが持つ。 */
  activeSiteView?: string | null;
  onSiteViewChange?: (id: string | null) => void;
};

type ReadyDashboard = Extract<ProjectDashboardResult, { status: "ready" }>;
type DashboardView = "overview" | "analytics" | "members" | "settings";
const VIEW_TITLES: Readonly<Record<DashboardView, string>> = { overview: "ダッシュボード", analytics: "アナリティクス", members: "メンバー", settings: "プロジェクト設定" };
const numberLabel = (value: number | null) => value === null ? "未取得" : value.toLocaleString("ja-JP");
const DISCONNECTED_TEXT = "アクセス解析はまだ接続されていません。";
const DISCONNECTED_HINT = "解析サービスを接続すると、訪問者数とページ表示数、対象期間をここに表示します。接続までは数値を表示しません。";
const ROLE_LABELS: Readonly<Record<ProjectMemberRole, string>> = { owner: "オーナー", editor: "編集者" };

function Overview({ overview }: { overview: ProjectOverview }) {
  return <><PublicationBadge status={overview.publicationStatus} />
    <p>{overview.publishedUrl ? <a className="pv-domain" href={overview.publishedUrl} target="_blank" rel="noopener noreferrer">{overview.publishedUrl}</a> : overview.publicationStatus === "unpublished" ? "サイトはまだ公開されていません。" : "公開URLは未取得です。"}</p>
    <dl className="pv-stats"><div><dt>公開ページ数</dt><dd>{numberLabel(overview.publishedPageCount)}</dd></div><div><dt>アセット使用量</dt><dd>{overview.assetBytes === null ? "未取得" : `${numberLabel(overview.assetBytes)} B`}</dd></div></dl>
    <p className="pv-muted">最終公開 {overview.lastPublishedAt === null && overview.publicationStatus === "unpublished" ? "未公開" : <Timestamp value={overview.lastPublishedAt} />}</p>
    {overview.publishedUrl && <div className="pv-actions"><a className="pv-link" href={overview.publishedUrl} target="_blank" rel="noopener noreferrer">公開サイト確認 <span aria-label="新しいタブ">↗</span></a></div>}
  </>;
}
function Analytics({ result, connect, retry, settingsAction }: { result: ReadyDashboard["analytics"]; connect: () => void; retry: () => void; settingsAction: "enabled" | "disabled" }) {
  const settingsButton = <button type="button" onClick={connect} disabled={settingsAction === "disabled"}>{settingsAction === "disabled" ? "解析接続（準備中）" : "解析接続設定"}</button>;
  if (result.status === "disconnected") return <><p>{DISCONNECTED_TEXT}</p><p className="pv-muted">{DISCONNECTED_HINT}</p><div className="pv-actions">{settingsButton}</div></>;
  if (result.status === "unavailable") return <><p role="alert">アクセス解析を取得できませんでした。</p><div className="pv-actions"><button type="button" onClick={retry}>再試行</button>{settingsButton}</div></>;
  return <><p className="pv-period">対象期間 <time dateTime={result.data.period.start}>{dateLabel(result.data.period.start)}</time> 〜 <time dateTime={result.data.period.end}>{dateLabel(result.data.period.end)}</time></p>
    <dl className="pv-stats"><div><dt>訪問者数</dt><dd>{numberLabel(result.data.uniqueVisitors)}</dd></div><div><dt>ページ表示数</dt><dd>{numberLabel(result.data.pageViews)}</dd></div></dl>
    <p className="pv-fetched">解析取得日時 <Timestamp value={result.data.fetchedAt} /></p><div className="pv-actions">{settingsButton}</div></>;
}
function AnalyticsSummary({ result, open }: { result: ReadyDashboard["analytics"]; open: () => void }) {
  return <section className="pv-panel pv-analytics-summary"><h3>アクセス解析</h3>
    {result.status === "ready" ? <><dl className="pv-stats"><div><dt>訪問者数</dt><dd>{numberLabel(result.data.uniqueVisitors)}</dd></div><div><dt>ページ表示数</dt><dd>{numberLabel(result.data.pageViews)}</dd></div></dl>
      <p className="pv-period">対象期間 <time dateTime={result.data.period.start}>{dateLabel(result.data.period.start)}</time> 〜 <time dateTime={result.data.period.end}>{dateLabel(result.data.period.end)}</time></p>
      <p className="pv-fetched">解析取得日時 <Timestamp value={result.data.fetchedAt} /></p></>
      : result.status === "disconnected" ? <><p>{DISCONNECTED_TEXT}</p><p className="pv-muted">{DISCONNECTED_HINT}</p></>
      : <p role="alert">アクセス解析を取得できませんでした。</p>}
    <div className="pv-actions"><button type="button" onClick={open}>アクセス解析を見る</button></div>
  </section>;
}

/** 読み取り専用のメンバー一覧。ホストが members を返さなければ Project 正本の参加者を役割なしで出す。招待・解除・権限変更はプロジェクト設定（ホスト）の役割。 */
function Members({ project, members, retry, openSettings }: { project: Project; members: ReadyDashboard["members"]; retry: () => void; openSettings: (() => void) | null }) {
  const section: ReadSection<readonly ProjectMemberSummary[]> = members ?? { status: "ready", data: project.members.map((member) => ({ displayName: member.displayName, role: null })) };
  if (section.status === "unavailable") return <section className="pv-panel"><h3>メンバー</h3><p role="alert">メンバーを取得できませんでした。</p><div className="pv-actions"><button type="button" onClick={retry}>再試行</button></div></section>;
  return <section className="pv-panel"><h3>メンバー（{section.data.length}名）</h3>
    {section.data.length === 0 ? <p className="pv-muted">メンバーはいません。</p>
      : <ul className="pv-member-list">{section.data.map((member, index) => <li key={index}><span className="pv-member-name">{member.displayName}</span>{member.role && <span className={`pv-role pv-role-${member.role}`}>{ROLE_LABELS[member.role]}</span>}</li>)}</ul>}
    {openSettings && <><p className="pv-muted">メンバーの招待・権限の変更・参加解除はプロジェクト設定で行います。</p><div className="pv-actions"><button type="button" onClick={openSettings}>プロジェクト設定を開く</button></div></>}
  </section>;
}

export function ProjectDashboard(props: ProjectDashboardProps) {
  const [source, setSource] = useState({ adapter: props.adapter, project: props.project, generation: 0 });
  if (source.adapter !== props.adapter || source.project !== props.project) {
    setSource({ adapter: props.adapter, project: props.project, generation: source.generation + 1 }); return null;
  }
  return <DashboardSession key={source.generation} {...props} />;
}
function DashboardSession({ project: inputProject, adapter, onBackToProjects, onOpenEditor, onOpenSettings, editorAction = "enabled", settingsAction = "enabled", settingsContent, siteViews = [], activeSiteView = null, onSiteViewChange }: ProjectDashboardProps) {
  const project = useMemo(() => { try { return parseProject(inputProject); } catch { return null; } }, [inputProject]);
  const reader = useCallback(async (signal: AbortSignal) => {
    if (!project) throw new Error("invalid selected project");
    const response = await adapter.loadDashboard({ projectId: project.id, siteId: project.site.id }, signal);
    return parseProjectDashboardResult(response, project);
  }, [adapter, project]);
  const { state, reload } = useProjectRead(reader);
  const [view, setView] = useState<DashboardView>("overview");
  const navId = useId();
  const result = state.status === "complete" && state.value.status === "ready" ? state.value : null;
  const siteView = siteViews.find((item) => item.id === activeSiteView) ?? null;
  /** Dashboard 側の画面へ移る（開いているサイト機能は閉じる） */
  const show = (next: DashboardView) => { if (siteView) onSiteViewChange?.(null); setView(next); };
  // 設定の中身を持つホストはいつでも開ける。持たないホストは onOpenSettings へ渡し、設定画面の無いホストでは無効にする
  const settingsDisabled = settingsContent === undefined && settingsAction === "disabled";
  const openSettings = (target: Project) => settingsContent === undefined ? onOpenSettings(target, "site") : show("settings");
  const current = (target: DashboardView) => !siteView && view === target ? "page" : undefined;
  return <section className="nw-project-view nw-project-dashboard" aria-label="プロジェクトダッシュボード"><style dangerouslySetInnerHTML={{ __html: projectViewCss }} />
    <header className="pv-project-bar">
      <button type="button" className="pv-project-back" onClick={onBackToProjects} aria-label="プロジェクト一覧へ戻る">‹</button>
      <div className="pv-project-identity" data-publication={result?.overview.status === "ready" ? result.overview.data.publicationStatus : "unknown"}>
        <h1>{result && project ? project.name : "プロジェクトダッシュボード"}</h1>
        {result && project && <span><i aria-hidden="true" />{project.site.domains[0] ?? project.site.name}</span>}
      </div>
      {result && project && <button type="button" className="pv-editor-link" onClick={() => onOpenEditor(project)}>{editorAction === "pending" ? "エディター接続待ち" : "デザインエディタ"}</button>}
    </header>
    {state.status !== "complete" ? <ReadNotice status={state.status} noun="ダッシュボード" retry={reload} />
      : state.value.status === "forbidden" ? <ReadNotice status="forbidden" noun="ダッシュボード" retry={reload} />
      : result && project && <div className="pv-dashboard-layout">
        <nav className="pv-dashboard-nav" aria-label="ダッシュボードメニュー">
          <div className="pv-nav-group" role="group" aria-labelledby={`${navId}-home`}>
            <p className="pv-nav-heading" id={`${navId}-home`}>ホーム</p>
            <button type="button" aria-current={current("overview")} onClick={() => show("overview")}>ダッシュボード</button>
            <button type="button" aria-current={current("members")} onClick={() => show("members")}>メンバー</button>
            <button type="button" aria-current={current("settings")} onClick={() => openSettings(project)} disabled={settingsDisabled}>{settingsDisabled ? "プロジェクト設定（準備中）" : "プロジェクト設定"}</button>
          </div>
          <div className="pv-nav-group" role="group" aria-labelledby={`${navId}-site`}>
            <p className="pv-nav-heading" id={`${navId}-site`}>サイト機能</p>
            {siteViews.map((item) => <button key={item.id} type="button" aria-current={siteView?.id === item.id ? "page" : undefined} onClick={() => onSiteViewChange?.(item.id)}>{item.label}</button>)}
            <button type="button" aria-current={current("analytics")} onClick={() => show("analytics")}>アナリティクス</button>
          </div>
        </nav>
        {siteView ? <main className="pv-site-view" aria-label={siteView.label}>{siteView.content}</main>
          : <main className="pv-dashboard-content">
            <h2 className="pv-page-title">{VIEW_TITLES[view]}</h2>
            {view === "settings" ? <div className="pv-settings">{settingsContent}</div>
              : view === "analytics" ? <section className="pv-panel"><h3>アクセス解析</h3><Analytics result={result.analytics} connect={() => onOpenSettings(project, "analytics")} retry={reload} settingsAction={settingsAction} /></section>
              : view === "members" ? <Members project={project} members={result.members} retry={reload} openSettings={settingsDisabled ? null : () => openSettings(project)} />
              : <div className="pv-sections"><section className="pv-panel"><h3>公開情報</h3>{result.overview.status === "ready" ? <Overview overview={result.overview.data} /> : <><p role="alert">公開情報を取得できませんでした。</p><button type="button" onClick={reload}>再試行</button></>}</section>
                <section className="pv-panel"><h3>直近の変更</h3>{result.overview.status === "unavailable" ? <p role="alert">変更履歴を取得できませんでした。</p> : result.overview.data.recentChanges.length === 0 ? <p className="pv-muted">直近の変更はありません。</p> : <ul className="pv-changes">{result.overview.data.recentChanges.map((change) => <li key={change.id}>{change.label}<Timestamp value={change.changedAt} /></li>)}</ul>}</section>
                <AnalyticsSummary result={result.analytics} open={() => setView("analytics")} />
              </div>}
            <div className="pv-footer"><p className="pv-fetched">ダッシュボード取得日時 <Timestamp value={result.fetchedAt} /></p><button type="button" onClick={reload}>再読込</button></div>
          </main>}
      </div>}
  </section>;
}
