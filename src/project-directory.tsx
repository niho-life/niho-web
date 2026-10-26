"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "./projects.js";
import { parseProjectDirectoryResult, type ProjectDirectoryAdapter, type ProjectSummary } from "./project-read-model.js";
import { ReadNotice, Timestamp, useProjectRead } from "./project-view-shared.js";
import { projectViewCss } from "./project-view-style.js";

export { parseProjectDirectoryResult } from "./project-read-model.js";
export type { ProjectDirectoryAdapter, ProjectDirectoryEntry, ProjectDirectoryResult, ProjectSummary } from "./project-read-model.js";
export type ProjectDirectoryProps = {
  adapter: ProjectDirectoryAdapter;
  onCreateProject: () => void;
  onOpenDashboard: (project: Project) => void;
  onOpenEditor: (project: Project) => void;
  /** ホストに作成機能がない場合はボタンを表示しない。既定値は従来どおりenabled。 */
  createAction?: "enabled" | "disabled";
  /** editor bridge未接続の説明を出すか、導線自体を隠すかをProjectごとに選べる。 */
  editorAction?: "enabled" | "pending" | "hidden" | ((project: Project) => "enabled" | "pending" | "hidden");
  /** visibleはProject.members、summaryはdisplay-only summaryだけを使う。取得不能時に相互を推測しない。 */
  memberDetails?: "visible" | "summary" | "hidden";
  /** host shellに検索欄を置く場合のcontrolled検索値。未指定なら一覧内でstateを持つ。 */
  searchValue?: string;
  onSearchValueChange?: (value: string) => void;
  /** host shellの検索欄を使う場合は、一覧内の重複する検索欄だけを隠す。 */
  searchControl?: "visible" | "external";
  /** 一覧へ戻ったとき、読込後にこのProjectの行へ一度だけfocusを戻す。 */
  initialFocusProjectId?: string;
};

function initial(value: string): string { return Array.from(value.trim())[0] ?? "?"; }

function Thumbnail({ thumbnail, siteName }: { thumbnail: ProjectSummary["thumbnail"]; siteName: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return <span className="pv-preview">{thumbnail && thumbnail.url !== failedUrl
    ? <img src={thumbnail.url} alt={thumbnail.alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedUrl(thumbnail.url)} />
    : <span className="pv-preview-initial" aria-hidden="true">{initial(siteName)}</span>}</span>;
}

type AvatarMember = { readonly displayName: string; readonly role?: "owner" | "editor" | null };
function memberLabel(member: AvatarMember): string {
  return `${member.displayName}${member.role === "owner" ? "（オーナー）" : member.role === "editor" ? "（編集者）" : ""}`;
}
function MemberAvatars({ members }: { members: readonly AvatarMember[] }) {
  if (members.length === 0) return null;
  const visible = members.slice(0, 3);
  return <span className="pv-avatars" aria-label={`メンバー ${members.map(memberLabel).join("、")}`}>
    {visible.map((member, index) => <span className="pv-avatar" title={memberLabel(member)} key={`${member.displayName}:${index}`}>{initial(member.displayName)}</span>)}
    {members.length > visible.length && <span className="pv-avatar pv-avatar-more">+{members.length - visible.length}</span>}
  </span>;
}

/** 日常の入口。作成・参加者管理はホストの既存ProjectManagerへ接続する。 */
export function ProjectDirectory(props: ProjectDirectoryProps) {
  const [source, setSource] = useState({ adapter: props.adapter, generation: 0 });
  if (source.adapter !== props.adapter) { setSource({ adapter: props.adapter, generation: source.generation + 1 }); return null; }
  return <DirectorySession key={source.generation} {...props} />;
}
function DirectorySession({ adapter, onCreateProject, onOpenDashboard, onOpenEditor, createAction = "enabled", editorAction = "enabled", memberDetails = "visible", searchValue, onSearchValueChange, searchControl = "visible", initialFocusProjectId }: ProjectDirectoryProps) {
  const editorActionFor = (project: Project) => typeof editorAction === "function" ? editorAction(project) : editorAction;
  const reader = useCallback(async (signal: AbortSignal) => parseProjectDirectoryResult(await adapter.loadDirectory(signal), (url) => adapter.isThumbnailUrlAllowed(url)), [adapter]);
  const { state, reload } = useProjectRead(reader);
  const [localQuery, setLocalQuery] = useState("");
  const query = searchValue ?? localQuery;
  const setQuery = (value: string) => { if (searchValue === undefined) setLocalQuery(value); onSearchValueChange?.(value); };
  const [sort, setSort] = useState("updated");
  const entries = state.status === "complete" && state.value.status === "ready" ? state.value.entries : null;
  const list = useRef<HTMLDivElement>(null), focusRestored = useRef(false);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("ja-JP");
    return (entries ?? []).filter(({ project }) => [project.name, project.site.name, ...project.site.domains].some((value) => value.toLocaleLowerCase("ja-JP").includes(needle))).slice().sort((a, b) => {
      if (sort === "name") return a.project.name.localeCompare(b.project.name, "ja");
      const aDate = a.summary.updatedAt, bDate = b.summary.updatedAt;
      return (bDate === null ? -Infinity : Date.parse(bDate)) - (aDate === null ? -Infinity : Date.parse(aDate)) || a.project.name.localeCompare(b.project.name, "ja");
    });
  }, [entries, query, sort]);
  useEffect(() => {
    if (!entries || !initialFocusProjectId || focusRestored.current) return;
    focusRestored.current = true;
    const row = Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button.pv-list-open") ?? []).find((node) => node.dataset.projectId === initialFocusProjectId);
    row?.focus(); row?.scrollIntoView?.({ block: "nearest" });
  }, [entries, initialFocusProjectId]);
  return <section className="nw-project-view" aria-label="プロジェクト一覧"><style dangerouslySetInnerHTML={{ __html: projectViewCss }} />
    <header className="pv-header"><h1 className="pv-heading">プロジェクト一覧</h1>{createAction === "enabled" && <button type="button" className="pv-primary" onClick={onCreateProject}>新規プロジェクト</button>}</header>
    {state.status !== "complete" ? <ReadNotice status={state.status} noun="プロジェクト一覧" retry={reload} />
      : state.value.status === "forbidden" ? <ReadNotice status="forbidden" noun="プロジェクト一覧" retry={reload} />
      : <><div className="pv-toolbar">
        {searchControl === "visible" && <label className="pv-search"><span>名前・ドメイン検索</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="プロジェクト名、サイト名、ドメイン" /></label>}
        <label><span>並び順</span><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="updated">更新が新しい順</option><option value="name">名前順</option></select></label>
        <button type="button" onClick={reload}>再読込</button>
      </div><p className="pv-muted" role="status">{visible.length}件</p>
      {entries?.length === 0 ? <div className="pv-notice"><p>{createAction === "disabled" ? "参加中のプロジェクトはまだありません。管理者に参加を依頼してください。" : "参加中のプロジェクトはまだありません。作成するか、管理者に参加を依頼してください。"}</p></div>
        : visible.length === 0 ? <div className="pv-notice"><p>条件に一致するプロジェクトがありません。</p><button type="button" onClick={() => setQuery("")}>検索解除</button></div>
        : <><ul className="pv-grid" aria-label="プロジェクトのプレビュー">{visible.map(({ project, summary }) => <li className="pv-card" key={project.id}>
          <button type="button" className="pv-open" data-project-id={project.id} onClick={() => onOpenDashboard(project)} aria-label={`${project.name}（${project.site.name}）のダッシュボード`}><Thumbnail thumbnail={summary.thumbnail} siteName={project.site.name} /><span className="pv-card-title"><span className="pv-card-name"><strong>{project.name}</strong>{summary.publicationStatus === "published" && <span className="pv-live" aria-label="公開中" title="公開中" />}</span>{project.site.domains.map((domain) => <span className="pv-domain" key={domain}>{domain}</span>)}</span></button>
        </li>)}</ul>
        <div className="pv-directory-list" ref={list}><h2>すべてのプロジェクト</h2><table><thead><tr><th scope="col">名前</th>{memberDetails !== "hidden" && <th scope="col">メンバー</th>}<th scope="col">最終更新</th><th scope="col"><span className="pv-visually-hidden">メニュー</span></th></tr></thead><tbody>{visible.map(({ project, summary }) => {
          const members = memberDetails === "visible" ? project.members : memberDetails === "summary" && summary.members?.status === "ready" ? summary.members.data : null;
          return <tr key={project.id}>
          <th scope="row" data-label="名前"><button type="button" className="pv-list-open" data-project-id={project.id} onClick={() => onOpenDashboard(project)} aria-label={`${project.name}（${project.site.name}）の一覧行を開く`}>{project.name}</button>{project.site.domains.map((domain) => <span className="pv-domain pv-muted" key={domain}>{domain}</span>)}</th>
          {memberDetails !== "hidden" && <td data-label="メンバー">{members !== null && <MemberAvatars members={members} />}</td>}
          <td data-label="最終更新">{summary.updatedAt !== null && <Timestamp value={summary.updatedAt} />}</td>
          <td data-label="メニュー"><details className="pv-project-menu"><summary aria-label={`${project.name}のメニュー`}>•••</summary><div><button type="button" onClick={() => onOpenDashboard(project)}>ダッシュボード</button>{editorActionFor(project) !== "hidden" && <button type="button" onClick={() => onOpenEditor(project)}>{editorActionFor(project) === "pending" ? "エディター接続待ち" : "エディター"}</button>}</div></details></td>
        </tr>})}</tbody></table></div></>}
      </>}
  </section>;
}
