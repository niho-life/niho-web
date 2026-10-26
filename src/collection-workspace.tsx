"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  COLLECTION_BULK_LIMIT, collectionDateFromInput, collectionItemFilter, collectionReorderSequence, isDisplayableImageUrl, moveCollectionIds,
  parseCollectionBulkResult, parseCollectionCreateResult, parseCollectionItemResult, parseCollectionListResult, parseCollectionPublishResult,
  parseCollectionRemoveResult, parseCollectionReorderResult, parseCollectionSaveResult, parseCollectionSchemaResult, parseCollectionUploadResult,
  sanitizeRichTextHtml, sortCollectionItems, validateCollectionValues,
  type CollectionAdapter, type CollectionBulkAction, type CollectionDefinition, type CollectionFieldError, type CollectionFilter, type CollectionItem,
  type CollectionItemStatus, type CollectionItemSummary, type CollectionValue, type CollectionValues,
} from "./collection-model.js";
import { displayImage, FieldView, fieldControlId, rejectMessages, type CollectionRichTextEditorProps, type FieldContext, type ReferenceCandidates } from "./collection-fields.js";
import { ConfirmDialog, DateTime, formatDateTime, Icon, MenuButton, StatusBadges, useRequests, zoneLabel, type ConfirmRequest, type MenuItem } from "./collection-ui.js";
import { collectionCss } from "./collection-style.js";

export {
  collectionDateFromInput, collectionDateInputValue, collectionItemFilter, collectionReorderSequence, isIsoTimestamp, isRichTextLinkAllowed,
  moveCollectionIds, parseCollectionBulkResult, parseCollectionCreateResult, parseCollectionItem, parseCollectionItemResult, parseCollectionItemSummary,
  parseCollectionListResult, parseCollectionPublishResult, parseCollectionRemoveResult, parseCollectionReorderResult, parseCollectionSaveResult,
  parseCollectionSchemaResult, parseCollectionUploadResult, parseCollectionValues, sanitizeRichTextHtml, sortCollectionItems, validateCollectionValues,
} from "./collection-model.js";
export type * from "./collection-model.js";
export type { CollectionRichTextEditorProps } from "./collection-fields.js";
export { DefaultRichText as CollectionRichTextEditor } from "./collection-fields.js";
export { collectionCss } from "./collection-style.js";

export type CollectionNavigationState = { readonly collectionId: string; readonly itemId: string | null };
export type CollectionWorkspaceProps = {
  adapter: CollectionAdapter;
  /** 最初に開くコレクション。無い・見つからないときは先頭。 */
  initialCollectionId?: string;
  /** 最初に開く項目（initialCollectionId と一緒に指定する）。 */
  initialItemId?: string;
  /** 一覧・項目を移ったとき。ホストが URL を合わせる。最初の表示では呼ばない。 */
  onNavigate?: (state: CollectionNavigationState) => void;
  /** リッチテキストの編集部品を差し替える。無ければ既定の contenteditable。 */
  renderRichText?: (props: CollectionRichTextEditorProps) => ReactNode;
  /** 日時の表示・入力のタイムゾーン。既定は Asia/Tokyo（日本時間）。 */
  timeZone?: string;
  /** 直してから下書きを自動で保存するまでの待ち時間（ms）。既定は 1000。 */
  autosaveDelay?: number;
};

type ListState = { readonly status: "loading" | "error" | "forbidden" } | { readonly status: "ready"; readonly items: readonly CollectionItemSummary[] };
type SchemaState = { readonly status: "loading" | "error" | "forbidden" } | { readonly status: "ready"; readonly collections: readonly CollectionDefinition[] };
type View = { readonly collectionId: string | null; readonly itemId: string | null; readonly created: CollectionItem | null };

const toSummary = (item: CollectionItem): CollectionItemSummary => ({
  id: item.id, title: item.title, subtitle: item.subtitle, imageUrl: item.imageUrl, path: item.path, status: item.status, publishedAt: item.publishedAt,
  updatedAt: item.updatedAt, updatedBy: item.updatedBy, scheduledAt: item.scheduledAt, publishFailed: item.publishFailed, order: item.order,
});
const messagesOf = (errors: readonly CollectionFieldError[]) => errors.map((error) => error.message);
/** サイトに出ている項目（削除の移動先を選べる）。 */
const isLive = (summary: Pick<CollectionItemSummary, "path" | "status">) => summary.path !== null && (summary.status === "published" || summary.status === "changed" || summary.status === "publishing");

/* ---------- 削除の移動先（capabilities.redirects） ---------- */

type RedirectCandidate = { readonly path: string; readonly title: string };
/** 移動先にできる、同じコレクションのほかの公開中の項目（path があり published・changed）。 */
function redirectCandidates(items: readonly CollectionItemSummary[] | null, ordering: CollectionDefinition["ordering"], selfId: string): RedirectCandidate[] {
  const seen = new Set<string>();
  return sortCollectionItems(items ?? [], ordering).flatMap((item) => {
    if (item.id === selfId || item.path === null || (item.status !== "published" && item.status !== "changed") || seen.has(item.path)) return [];
    seen.add(item.path);
    return [{ path: item.path, title: item.title || "無題" }];
  });
}
/** undefined = 一覧へ移す（ホストの既定）、null = 移さない、string = ほかの項目の path。 */
type RedirectTo = string | null | undefined;
function RedirectChoices({ label, path, candidates, onChange }: { label: string; path: string; candidates: readonly RedirectCandidate[]; onChange: (value: RedirectTo) => void }) {
  const name = useId();
  const [kind, setKind] = useState<"list" | "other" | "none">("list");
  const [other, setOther] = useState(candidates[0]?.path ?? "");
  const choose = (nextKind: "list" | "other" | "none", nextPath = other) => {
    setKind(nextKind);
    setOther(nextPath);
    onChange(nextKind === "list" ? undefined : nextKind === "none" ? null : nextPath);
  };
  return <fieldset className="cw-choices">
    <legend>このアドレス（<span className="cw-address">{path}</span>）を開いた人の移動先</legend>
    <label className="cw-choice"><input type="radio" name={name} checked={kind === "list"} onChange={() => choose("list")} /><span>一覧へ移す</span></label>
    {candidates.length > 0 && <label className="cw-choice"><input type="radio" name={name} checked={kind === "other"} onChange={() => choose("other")} /><span>ほかの{label}へ移す</span></label>}
    {kind === "other" && <select className="cw-input cw-select" aria-label={`移動先の${label}`} value={other} onChange={(event) => choose("other", event.target.value)}>
      {candidates.map((candidate) => <option key={candidate.path} value={candidate.path}>{candidate.title}（{candidate.path}）</option>)}
    </select>}
    <label className="cw-choice"><input type="radio" name={name} checked={kind === "none"} onChange={() => choose("none")} /><span>移さない<span className="cw-hint">このアドレスを開いた人には「見つかりません」が出ます。</span></span></label>
  </fieldset>;
}
/** 削除の確認。転送できるホストで公開中の項目なら、移動先の 3 つの選択を出す。 */
function removeConfirm(definition: CollectionDefinition, title: string, summary: Pick<CollectionItemSummary, "path" | "status">, candidates: readonly RedirectCandidate[], run: (redirectTo: RedirectTo) => Promise<void>): ConfirmRequest {
  const heading = `「${title}」を削除しますか？`;
  if (!definition.capabilities.redirects || !isLive(summary)) {
    return { title: heading, body: summary.status === "draft" ? "削除は元に戻せません。" : "サイトからも外れます。削除は元に戻せません。", confirmLabel: "削除する", tone: "danger", run: () => run(undefined) };
  }
  const choice: { value: RedirectTo } = { value: undefined };
  return {
    title: heading, body: "サイトから外れます。削除は元に戻せません。", confirmLabel: "削除する", tone: "danger",
    extra: <RedirectChoices label={definition.label} path={summary.path!} candidates={candidates} onChange={(value) => { choice.value = value; }} />,
    run: () => run(choice.value),
  };
}
const redirectInput = (redirectTo: RedirectTo) => redirectTo === undefined ? {} : { redirectTo };

/* ---------- まとめての操作 ---------- */

type BulkOutcome = { readonly kind: "done" | "kept" } | { readonly kind: "invalid"; readonly messages: readonly string[] };
const bulkDone: Record<CollectionBulkAction, readonly [string, string]> = {
  publish: ["公開しました。", "サイトに出るまで少しかかります。"],
  unpublish: ["下書きに戻しました。", "サイトから外れるまで少しかかります。"],
  remove: ["削除しました。", "サイトから外れるまで少しかかります。"],
};
/** 並べて読む（同時に limit 本まで）。 */
async function eachLimited<T>(list: readonly T[], limit: number, run: (entry: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => { while (next < list.length) await run(list[next++]!); }));
}

/** コレクション（CMS）の一覧と項目の編集。adapter を差し替えると中身を作り直し、古い応答を捨てる。 */
export function CollectionWorkspace(props: CollectionWorkspaceProps) {
  const [source, setSource] = useState({ adapter: props.adapter, generation: 0 });
  if (source.adapter !== props.adapter) { setSource({ adapter: props.adapter, generation: source.generation + 1 }); return null; }
  return <WorkspaceSession key={source.generation} {...props} />;
}

function Notice({ status, noun, retry }: { status: "loading" | "error" | "forbidden"; noun: string; retry?: () => void }) {
  return <div className="cw-notice" aria-busy={status === "loading"}>
    <p role={status === "loading" ? "status" : "alert"}>{status === "loading" ? `${noun}を読み込んでいます…` : status === "forbidden" ? `${noun}を見る権限がありません。管理者に確かめてください。` : `${noun}を読み込めませんでした。`}</p>
    {status !== "loading" && retry && <button type="button" className="cw-button" onClick={retry}>再試行</button>}
  </div>;
}

function WorkspaceSession({ adapter, initialCollectionId, initialItemId, onNavigate, renderRichText, timeZone = "Asia/Tokyo", autosaveDelay = 1000 }: CollectionWorkspaceProps) {
  const requests = useRequests();
  const [schema, setSchema] = useState<SchemaState>({ status: "loading" });
  const [lists, setLists] = useState<Readonly<Record<string, ListState>>>({});
  const [view, setView] = useState<View>({ collectionId: initialCollectionId ?? null, itemId: initialCollectionId !== undefined && initialItemId !== undefined ? initialItemId : null, created: null });
  const [toast, setToast] = useState<{ readonly text: string; readonly error: boolean; readonly id: number } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [focusItem, setFocusItem] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** 並べ替えの応答待ち。ids はその間に出す並び。 */
  const [moving, setMoving] = useState<{ readonly collectionId: string; readonly ids: readonly string[] } | null>(null);
  const listSeq = useRef(new Map<string, number>()), schemaSeq = useRef(0), toastSeq = useRef(0), movingNow = useRef(false);

  const notify = useCallback((text: string, error = false) => setToast({ text, error, id: ++toastSeq.current }), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.error ? 10_000 : 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const setList = (collectionId: string, state: ListState) => setLists((previous) => ({ ...previous, [collectionId]: state }));
  const loadList = useCallback(async (collectionId: string, quiet = false) => {
    const seq = (listSeq.current.get(collectionId) ?? 0) + 1;
    listSeq.current.set(collectionId, seq);
    if (!quiet) setList(collectionId, { status: "loading" });
    const outcome = await requests.current.run(async (signal) => parseCollectionListResult(await adapter.listItems({ collectionId }, signal), collectionId));
    if (outcome.kind === "aborted" || listSeq.current.get(collectionId) !== seq) return;
    setLists((previous) => {
      const current = previous[collectionId];
      const next: ListState = outcome.kind === "error" ? (quiet && current?.status === "ready" ? current : { status: "error" })
        : outcome.value.status === "forbidden" ? { status: "forbidden" } : { status: "ready", items: outcome.value.items };
      return { ...previous, [collectionId]: next };
    });
  }, [adapter, requests]);

  const loadSchema = useCallback(async () => {
    const seq = ++schemaSeq.current;
    setSchema({ status: "loading" });
    const outcome = await requests.current.run(async (signal) => parseCollectionSchemaResult(await adapter.loadSchema(signal)));
    if (outcome.kind === "aborted" || seq !== schemaSeq.current) return;
    if (outcome.kind === "error") { setSchema({ status: "error" }); return; }
    if (outcome.value.status === "forbidden") { setSchema({ status: "forbidden" }); setLists({}); return; }
    const collections = outcome.value.collections;
    setSchema({ status: "ready", collections });
    setView((previous) => collections.some((definition) => definition.id === previous.collectionId) ? previous : { collectionId: collections[0]?.id ?? null, itemId: null, created: null });
    for (const definition of collections) void loadList(definition.id);
  }, [adapter, requests, loadList]);
  useEffect(() => { void loadSchema(); }, [loadSchema]);

  const go = (collectionId: string, itemId: string | null, created: CollectionItem | null = null) => {
    setView({ collectionId, itemId, created });
    onNavigate?.({ collectionId, itemId });
  };
  const upsert = useCallback((collectionId: string, item: CollectionItem) => setLists((previous) => {
    const state = previous[collectionId];
    if (state?.status !== "ready") return previous;
    const summary = toSummary(item), index = state.items.findIndex((entry) => entry.id === item.id);
    const items = index < 0 ? [summary, ...state.items] : state.items.map((entry, position) => position === index ? summary : entry);
    return { ...previous, [collectionId]: { status: "ready", items } };
  }), []);
  const drop = (collectionId: string, itemId: string) => setLists((previous) => {
    const state = previous[collectionId];
    return state?.status === "ready" ? { ...previous, [collectionId]: { status: "ready", items: state.items.filter((entry) => entry.id !== itemId) } } : previous;
  });
  /** 操作の応答の一覧で置き換える（読み込み中の古い一覧は捨てる）。 */
  const replaceList = (collectionId: string, items: readonly CollectionItemSummary[]) => {
    listSeq.current.set(collectionId, (listSeq.current.get(collectionId) ?? 0) + 1);
    setList(collectionId, { status: "ready", items });
  };

  const collections = schema.status === "ready" ? schema.collections : [];
  const definition = collections.find((candidate) => candidate.id === view.collectionId) ?? null;
  const references = (collectionId: string): ReferenceCandidates => {
    const state = lists[collectionId];
    return !state ? { status: "loading" } : state.status === "ready" ? { status: "ready", items: state.items } : { status: state.status };
  };
  const listedItems = (collectionId: string) => { const state = lists[collectionId]; return state?.status === "ready" ? state.items : null; };

  /* ---------- 一覧からの操作（最新を読んで version を付けてから） ---------- */
  const afterListAction = (target: CollectionDefinition, status: string, success: string) => {
    if (status === "forbidden") { setList(target.id, { status: "forbidden" }); return; }
    if (status === "conflict") notify("ほかの人が先に変更していました。一覧を読み込み直したので、もう一度試してください。", true);
    else if (status === "invalid") notify("この操作はできませんでした。項目を開いて確かめてください。", true);
    else if (status === "not_found") notify("見つかりませんでした。削除されたかもしれません。一覧を読み込み直しました。", true);
    else notify(success);
    void loadList(target.id, true);
  };
  const withLatest = async (target: CollectionDefinition, summary: CollectionItemSummary, action: (item: CollectionItem) => Promise<void>) => {
    const outcome = await requests.current.run(async (signal) => parseCollectionItemResult(await adapter.loadItem({ collectionId: target.id, itemId: summary.id }, signal), target, summary.id));
    if (outcome.kind === "aborted") return;
    if (outcome.kind === "error") { notify("操作できませんでした。もう一度試してください。", true); return; }
    if (outcome.value.status !== "ready") { afterListAction(target, outcome.value.status, ""); return; }
    await action(outcome.value.item);
  };
  const failed = () => notify("操作できませんでした。もう一度試してください。", true);
  const rowMenu = (target: CollectionDefinition, summary: CollectionItemSummary): MenuItem[] => {
    const title = summary.title || "無題", items: MenuItem[] = [{ label: "開く", onSelect: () => go(target.id, summary.id) }];
    if (target.capabilities.duplicate && adapter.duplicate) items.push({ label: "複製する", onSelect: () => void (async () => {
      const outcome = await requests.current.run(async (signal) => parseCollectionCreateResult(await adapter.duplicate!({ collectionId: target.id, itemId: summary.id }, signal), target));
      if (outcome.kind === "ok") afterListAction(target, outcome.value.status, "複製しました。下書きとして一覧に入っています。");
      else if (outcome.kind === "error") failed();
    })() });
    if (target.capabilities.unpublish && adapter.unpublish && (summary.status === "published" || summary.status === "changed")) items.push({ label: "非公開にする", onSelect: () => setConfirm({
      title: `「${title}」を非公開にしますか？`, body: "サイトから外れます。もう一度公開するまで、このアドレスは開けなくなります。", confirmLabel: "非公開にする", tone: "danger",
      run: () => withLatest(target, summary, async (item) => {
        const outcome = await requests.current.run(async (signal) => parseCollectionSaveResult(await adapter.unpublish!({ collectionId: target.id, itemId: item.id, version: item.version }, signal), target, item.id));
        if (outcome.kind === "ok") afterListAction(target, outcome.value.status, "非公開にしました。サイトから外れるまで少しかかります。");
        else if (outcome.kind === "error") failed();
      }),
    }) });
    if (target.capabilities.remove && adapter.remove) items.push({ label: "削除する", danger: true, onSelect: () => setConfirm(removeConfirm(target, title, summary, redirectCandidates(listedItems(target.id), target.ordering, summary.id), (redirectTo) => withLatest(target, summary, async (item) => {
      const outcome = await requests.current.run(async (signal) => parseCollectionRemoveResult(await adapter.remove!({ collectionId: target.id, itemId: item.id, version: item.version, ...redirectInput(redirectTo) }, signal), target, item.id));
      if (outcome.kind === "ok") {
        const result = outcome.value;
        if (result.status === "invalid") { notify(messagesOf(result.errors).join(" ") || "削除できませんでした。", true); void loadList(target.id, true); return; }
        if (result.status === "removed") drop(target.id, item.id);
        afterListAction(target, result.status, "削除しました。");
      } else if (outcome.kind === "error") failed();
    }))) });
    return items;
  };

  /* ---------- 並べ替え・まとめての操作 ---------- */
  const reorder = async (target: CollectionDefinition, ids: readonly string[], from: number, to: number): Promise<boolean> => {
    if (!adapter.reorder || movingNow.current) return false;
    movingNow.current = true;
    setMoving({ collectionId: target.id, ids: moveCollectionIds(ids, from, to) });
    const outcome = await requests.current.run(async (signal) => parseCollectionReorderResult(await adapter.reorder!({ collectionId: target.id, ids: [...ids], from, to }, signal)));
    movingNow.current = false;
    setMoving(null);
    if (outcome.kind === "aborted") return false;
    if (outcome.kind === "error") { notify("並べ替えられませんでした。もう一度試してください。", true); void loadList(target.id, true); return false; }
    const result = outcome.value;
    if (result.status === "forbidden" || result.status === "not_found") { afterListAction(target, result.status, ""); return false; }
    if (result.status === "invalid") { notify(messagesOf(result.errors).join(" ") || "並べ替えられませんでした。", true); void loadList(target.id, true); return false; }
    replaceList(target.id, result.items);
    if (result.status === "conflict") { notify("ほかの人が先に並びを変えていました。一覧を読み込み直したので、もう一度並べ替えてください。", true); return false; }
    notify(result.status === "publishing" ? "並べ替えました。サイトに出るまで少しかかります。" : "並べ替えました。");
    return true;
  };
  const bulk = async (target: CollectionDefinition, action: CollectionBulkAction, chosen: readonly CollectionItemSummary[]): Promise<BulkOutcome> => {
    if (!adapter.bulk || chosen.length === 0 || chosen.length > COLLECTION_BULK_LIMIT) return { kind: "kept" };
    // 一覧の要約は version を持たないので、先に最新を読む（ほかの人の変更を上書きしないため）
    const versions = new Map<string, string>();
    let problem: "error" | "forbidden" | "not_found" | null = null, aborted = false;
    await eachLimited(chosen, 6, async (summary) => {
      if (problem || aborted) return;
      const outcome = await requests.current.run(async (signal) => parseCollectionItemResult(await adapter.loadItem({ collectionId: target.id, itemId: summary.id }, signal), target, summary.id));
      if (outcome.kind === "aborted") aborted = true;
      else if (outcome.kind === "error") problem ??= "error";
      else if (outcome.value.status !== "ready") problem ??= outcome.value.status;
      else versions.set(summary.id, outcome.value.item.version);
    });
    if (aborted) return { kind: "kept" };
    if (problem === "error") { failed(); return { kind: "kept" }; }
    if (problem) { afterListAction(target, problem, ""); return { kind: "kept" }; }
    const items = chosen.map((summary) => ({ id: summary.id, version: versions.get(summary.id)! }));
    const outcome = await requests.current.run(async (signal) => parseCollectionBulkResult(await adapter.bulk!({ collectionId: target.id, action, items }, signal)));
    if (outcome.kind === "aborted") return { kind: "kept" };
    if (outcome.kind === "error") { failed(); void loadList(target.id, true); return { kind: "kept" }; }
    const result = outcome.value;
    if (result.status === "forbidden" || result.status === "not_found") { afterListAction(target, result.status, ""); return { kind: "kept" }; }
    if (result.status === "invalid") return { kind: "invalid", messages: messagesOf(result.errors) };
    replaceList(target.id, result.items);
    if (result.status === "conflict") { notify("ほかの人が先に変えました。一覧を読み込み直したので、確かめてからもう一度試してください。", true); return { kind: "kept" }; }
    const [done, later] = bulkDone[action];
    notify(`${items.length} 件を${done}${result.status === "publishing" ? later : ""}`);
    return { kind: "done" };
  };
  const create = async (target: CollectionDefinition) => {
    if (!adapter.createItem || creating) return;
    setCreating(true);
    const outcome = await requests.current.run(async (signal) => parseCollectionCreateResult(await adapter.createItem!({ collectionId: target.id }, signal), target));
    setCreating(false);
    if (outcome.kind === "aborted") return;
    if (outcome.kind === "error") { notify("作れませんでした。もう一度試してください。", true); return; }
    if (outcome.value.status !== "created") { afterListAction(target, outcome.value.status, ""); return; }
    upsert(target.id, outcome.value.item);
    go(target.id, outcome.value.item.id, outcome.value.item);
  };

  let body: ReactNode;
  if (schema.status !== "ready") body = <Notice status={schema.status} noun="コンテンツ" retry={() => void loadSchema()} />;
  else if (!definition) body = <div className="cw-notice"><p>編集できるコレクションはありません。</p></div>;
  else if (view.itemId !== null) {
    const target = definition, itemId = view.itemId;
    body = <ItemEditor key={`${target.id}/${itemId}`} adapter={adapter} definition={target} itemId={itemId} created={view.created} timeZone={timeZone} autosaveDelay={autosaveDelay}
      renderRichText={renderRichText} references={references} retryReferences={(collectionId) => void loadList(collectionId)} confirm={setConfirm}
      redirectCandidates={() => redirectCandidates(listedItems(target.id), target.ordering, itemId)}
      onSaved={(item) => upsert(target.id, item)}
      onBack={() => { go(target.id, null); setFocusItem(itemId); void loadList(target.id, true); }}
      onRemoved={(message) => { drop(target.id, itemId); notify(message); go(target.id, null); void loadList(target.id, true); }}
      onOpenItem={(item) => { upsert(target.id, item); notify("複製しました。複製した下書きを開いています。"); go(target.id, item.id, item); }} />;
  } else {
    const state = lists[definition.id] ?? { status: "loading" as const };
    body = <div className="cw-layout">
      <nav className="cw-nav" aria-label="コレクション">
        <h2 className="cw-nav-heading">コンテンツ</h2>
        <ul>{collections.map((entry) => {
          const list = lists[entry.id];
          return <li key={entry.id}><button type="button" aria-current={entry.id === definition.id ? "page" : undefined} onClick={() => { if (entry.id !== definition.id) go(entry.id, null); }}>
            <Icon name={entry.icon ?? "document"} /><span className="cw-nav-label">{entry.label}</span>
            {list?.status === "ready" && <span className="cw-nav-count"><span className="cw-sr">（</span>{list.items.length}<span className="cw-sr"> 件）</span></span>}
          </button></li>;
        })}</ul>
      </nav>
      <div className="cw-main">
        <ItemList key={definition.id} definition={definition} state={state} timeZone={timeZone} focusItem={focusItem} onFocused={() => setFocusItem(null)}
          imageSrc={(url, width) => displayImage(url, width, adapter.imageUrl ? (value, size) => adapter.imageUrl!(value, size) : undefined)}
          canCreate={definition.capabilities.create && !!adapter.createItem} creating={creating} onCreate={() => void create(definition)}
          onOpen={(itemId) => go(definition.id, itemId)} onRetry={() => void loadList(definition.id)} menuFor={(summary) => rowMenu(definition, summary)} confirm={setConfirm}
          reorder={definition.capabilities.reorder && adapter.reorder && definition.ordering === "manual"
            ? { pending: moving?.collectionId === definition.id ? moving.ids : null, onMove: (ids, from, to) => reorder(definition, ids, from, to) } : null}
          bulk={definition.capabilities.bulk && adapter.bulk ? (action, chosen) => bulk(definition, action, chosen) : null} />
      </div>
    </div>;
  }
  return <section className="nw-collection" aria-label="コンテンツ"><style dangerouslySetInnerHTML={{ __html: collectionCss }} />
    {body}
    <div className="cw-toast-region">{toast && <div key={toast.id} className="cw-toast" data-tone={toast.error ? "error" : "info"} role={toast.error ? "alert" : "status"}>
      <p>{toast.text}</p><button type="button" className="cw-icon-button" aria-label="知らせを閉じる" onClick={() => setToast(null)}><Icon name="close" /></button>
    </div>}</div>
    {confirm && <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />}
  </section>;
}

/* ---------- 一覧 ---------- */

function Thumb({ src }: { src: string | null }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return src && src !== failedSrc ? <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedSrc(src)} /> : <Icon name="image" />;
}

type ReorderControl = { readonly pending: readonly string[] | null; readonly onMove: (ids: readonly string[], from: number, to: number) => Promise<boolean> };
type BulkRun = (action: CollectionBulkAction, chosen: readonly CollectionItemSummary[]) => Promise<BulkOutcome>;
const bulkFailed: Record<CollectionBulkAction, string> = { publish: "まとめて公開できませんでした。", unpublish: "まとめて下書きに戻せませんでした。", remove: "まとめて削除できませんでした。" };

function ItemList({ definition, state, timeZone, focusItem, onFocused, imageSrc, canCreate, creating, onCreate, onOpen, onRetry, menuFor, confirm, reorder, bulk }: {
  definition: CollectionDefinition; state: ListState; timeZone: string; focusItem: string | null; onFocused: () => void;
  imageSrc: (url: string | null, width: number) => string | null; canCreate: boolean; creating: boolean; onCreate: () => void;
  onOpen: (itemId: string) => void; onRetry: () => void; menuFor: (summary: CollectionItemSummary) => MenuItem[]; confirm: (request: ConfirmRequest) => void;
  /** 並べ替えられるとき（capabilities.reorder・adapter.reorder・manual）。 */
  reorder: ReorderControl | null;
  /** まとめて操作できるとき（capabilities.bulk・adapter.bulk）。 */
  bulk: BulkRun | null;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CollectionFilter>("all");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<CollectionBulkAction | null>(null);
  const [bulkErrors, setBulkErrors] = useState<{ readonly action: CollectionBulkAction; readonly messages: readonly string[] } | null>(null);
  const [drag, setDrag] = useState<{ readonly id: string; readonly from: number; readonly to: number } | null>(null);
  const [refocus, setRefocus] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null), selectAll = useRef<HTMLInputElement>(null);
  const dragging = useRef<{ readonly pointerId: number; readonly id: string; readonly from: number; readonly ids: readonly string[] } | null>(null);
  const items = state.status === "ready" ? state.items : null;
  const pending = reorder?.pending ?? null;
  const canReorder = reorder !== null && definition.ordering === "manual";
  /** 並べ替えの並び（order のある項目）。応答待ちの間は動かした後の並びを出す。 */
  const sequence = useMemo(() => {
    if (!canReorder || !items) return [];
    const base = collectionReorderSequence(items);
    if (!pending) return base;
    const byId = new Map(base.map((item) => [item.id, item]));
    const moved = pending.flatMap((id) => { const item = byId.get(id); return item ? [item] : []; });
    return moved.length === base.length ? moved : base;
  }, [canReorder, items, pending]);
  const sorted = useMemo(() => canReorder
    ? [...sortCollectionItems((items ?? []).filter((item) => item.order === null), "manual"), ...sequence]
    : sortCollectionItems(items ?? [], definition.ordering), [canReorder, items, sequence, definition.ordering]);
  const counts = useMemo(() => ({
    all: sorted.length,
    published: sorted.filter((item) => collectionItemFilter(item.status) === "published").length,
    draft: sorted.filter((item) => collectionItemFilter(item.status) === "draft").length,
  }), [sorted]);
  const needle = query.trim().toLocaleLowerCase("ja-JP");
  const visible = sorted.filter((item) => (filter === "all" || collectionItemFilter(item.status) === filter) &&
    (!needle || item.title.toLocaleLowerCase("ja-JP").includes(needle) || (item.path ?? "").toLocaleLowerCase("ja-JP").includes(needle)));
  const reorderActive = canReorder && filter === "all" && !needle;
  const sequenceIds = sequence.map((item) => item.id);
  const chosen = bulk ? visible.filter((item) => selected.has(item.id)) : [];
  const visibleKey = visible.map((item) => item.id).join("\n");
  const imageField = definition.fields.find((field) => field.key === definition.imageField);
  const shape = imageField?.type === "image" && imageField.shape === "round" ? "round" : "rect";
  useEffect(() => {
    if (!items || !focusItem) return;
    const target = Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button.cw-row-open") ?? []).find((node) => node.dataset.itemId === focusItem);
    target?.focus();
    target?.scrollIntoView?.({ block: "nearest" });
    onFocused();
  }, [items, focusItem, onFocused]);
  // 見えなくなった行（絞り込み・削除）は選択から外す
  useEffect(() => {
    const shown = new Set(visibleKey ? visibleKey.split("\n") : []);
    setSelected((previous) => [...previous].every((id) => shown.has(id)) ? previous : new Set([...previous].filter((id) => shown.has(id))));
  }, [visibleKey]);
  useEffect(() => { if (selectAll.current) selectAll.current.indeterminate = chosen.length > 0 && chosen.length < visible.length; });
  // 「上へ」「下へ」の後は、動かした行の「…」へ focus を戻す（行の DOM が動くと focus が外れるため）
  useEffect(() => {
    if (!refocus) return;
    Array.from(list.current?.querySelectorAll<HTMLElement>("li.cw-row") ?? []).find((node) => node.dataset.rowId === refocus)?.querySelector<HTMLButtonElement>(".cw-row-menu button")?.focus();
    if (!pending) setRefocus(null);
  }, [refocus, pending, sorted]);
  // ドラッグ中の Esc は取り消し
  useEffect(() => {
    if (!drag) return;
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") { dragging.current = null; setDrag(null); } };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [drag]);

  const move = (ids: readonly string[], from: number, to: number) => { if (reorder && !pending && from !== to) void reorder.onMove(ids, from, to); };
  const menu = (item: CollectionItemSummary): MenuItem[] => {
    const base = menuFor(item), index = reorderActive && !pending && item.order !== null ? sequenceIds.indexOf(item.id) : -1;
    if (index < 0) return base;
    const moves: MenuItem[] = [];
    if (index > 0) moves.push({ label: "上へ", onSelect: () => { setRefocus(item.id); move(sequenceIds, index, index - 1); } });
    if (index < sequenceIds.length - 1) moves.push({ label: "下へ", onSelect: () => { setRefocus(item.id); move(sequenceIds, index, index + 1); } });
    return [...base.slice(0, 1), ...moves, ...base.slice(1)];
  };
  /** 指の位置から、動かした後の位置（自分以外で中心が指より上にある行の数）を出す。 */
  const dropIndex = (clientY: number) => {
    const info = dragging.current;
    if (!info) return 0;
    const rows = Array.from(list.current?.querySelectorAll<HTMLElement>("li.cw-row") ?? []);
    return info.ids.filter((id, index) => {
      if (index === info.from) return false;
      const rect = rows.find((node) => node.dataset.rowId === id)?.getBoundingClientRect();
      return rect ? rect.top + rect.height / 2 < clientY : false;
    }).length;
  };
  const grab = (event: ReactPointerEvent<HTMLElement>, id: string) => {
    if (!reorderActive || pending || (event.pointerType === "mouse" && event.button !== 0)) return;
    const from = sequenceIds.indexOf(id);
    if (from < 0) return;
    event.preventDefault();
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* 捕まえられなくても動かせる */ }
    dragging.current = { pointerId: event.pointerId, id, from, ids: sequenceIds };
    setDrag({ id, from, to: from });
  };
  const drift = (event: ReactPointerEvent<HTMLElement>) => {
    const info = dragging.current;
    if (!info || event.pointerId !== info.pointerId) return;
    const to = dropIndex(event.clientY);
    setDrag((previous) => previous && previous.to !== to ? { ...previous, to } : previous);
  };
  const release = (event: ReactPointerEvent<HTMLElement>) => {
    const info = dragging.current;
    if (!info || event.pointerId !== info.pointerId) return;
    const to = dropIndex(event.clientY);
    dragging.current = null;
    setDrag(null);
    move(info.ids, info.from, to);
  };
  const dropSide = (id: string): "before" | "after" | undefined => {
    if (!drag || drag.to === drag.from || sequenceIds[drag.to] !== id) return undefined;
    return drag.to > drag.from ? "after" : "before";
  };

  const runBulk = async (action: CollectionBulkAction, targets: readonly CollectionItemSummary[]) => {
    if (!bulk) return;
    setBulkBusy(action);
    setBulkErrors(null);
    try {
      const result = await bulk(action, targets);
      if (result.kind === "done") { setSelected(new Set()); selectAll.current?.focus(); }
      else if (result.kind === "invalid") setBulkErrors({ action, messages: result.messages.length ? result.messages : [bulkFailed[action]] });
    } finally { setBulkBusy(null); }
  };
  const startBulk = (action: CollectionBulkAction) => {
    const targets = chosen, count = targets.length;
    if (action === "publish") { void runBulk(action, targets); return; }
    confirm(action === "remove" ? {
      title: `${count} 件の${definition.label}を削除しますか？`,
      body: definition.capabilities.redirects ? "公開中の項目のアドレスは一覧へ移します。削除は元に戻せません。" : "公開中の項目はサイトからも外れます。削除は元に戻せません。",
      confirmLabel: "削除する", tone: "danger", run: () => runBulk(action, targets),
    } : {
      title: `${count} 件を下書きに戻しますか？`, body: "公開中の項目はサイトから外れます。もう一度公開するまで、そのアドレスは開けなくなります。",
      confirmLabel: "下書きに戻す", tone: "danger", run: () => runBulk(action, targets),
    });
  };
  const toggle = (id: string, on: boolean) => { setBulkErrors(null); setSelected((previous) => { const next = new Set(previous); if (on) next.add(id); else next.delete(id); return next; }); };
  const allChosen = visible.length > 0 && chosen.length === visible.length;
  const tooMany = chosen.length > COLLECTION_BULK_LIMIT;
  const lead = bulk && reorderActive ? "both" : bulk ? "select" : reorderActive ? "grip" : undefined;

  const tabs: readonly [CollectionFilter, string][] = [["all", "すべて"], ["published", "公開中"], ["draft", "下書き"]];
  return <div className="cw-list">
    <header className="cw-list-head">
      <div className="cw-list-title"><h2>{definition.label}</h2>{items && <span className="cw-count">{items.length} 件</span>}</div>
      <div className="cw-list-actions">
        <label className="cw-search"><Icon name="search" /><span className="cw-sr">題名で検索</span>
          <input type="search" value={query} placeholder="題名で検索" autoComplete="off" onChange={(event) => setQuery(event.target.value)} /></label>
        {canCreate && <button type="button" className="cw-button cw-primary" onClick={onCreate} disabled={creating}><Icon name="plus" />{creating ? "作っています…" : definition.addLabel}</button>}
      </div>
    </header>
    {state.status !== "ready" ? <Notice status={state.status} noun={definition.label} retry={onRetry} /> : <>
      <div className="cw-filters" role="group" aria-label="状態で絞り込む">{tabs.map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>
        {label}<span className="cw-filter-count"><span className="cw-sr">（</span>{counts[value]}<span className="cw-sr"> 件）</span></span></button>)}</div>
      {sorted.length === 0 ? <div className="cw-empty"><p>まだありません。</p>{canCreate && <button type="button" className="cw-button" onClick={onCreate} disabled={creating}><Icon name="plus" />{definition.addLabel}</button>}</div>
        : visible.length === 0 ? <div className="cw-empty"><p>{needle ? `「${query.trim()}」に当てはまる${definition.label}はありません。` : `${tabs.find(([value]) => value === filter)?.[1]}の${definition.label}はありません。`}</p>
          <button type="button" className="cw-button" onClick={() => { setQuery(""); setFilter("all"); }}>絞り込みをやめる</button></div>
        : <>
          <p className="cw-sr" role="status">{visible.length} 件を表示しています</p>
          {canReorder && !reorderActive && sequence.length > 1 && <p className="cw-hint cw-list-hint">並べ替えは、検索と絞り込みをやめると使えます。</p>}
          {bulk && <div className="cw-bulk" role="group" aria-label="まとめての操作" data-active={chosen.length > 0}>
            <label className="cw-check"><input ref={selectAll} type="checkbox" checked={allChosen} disabled={!!bulkBusy}
              onChange={() => { setBulkErrors(null); setSelected(allChosen ? new Set() : new Set(visible.map((item) => item.id))); }} /><span>全部を選ぶ</span></label>
            {chosen.length > 0 && <>
              <span className="cw-bulk-count">{chosen.length} 件を選択中</span>
              <span className="cw-bulk-actions">
                <button type="button" className="cw-button" disabled={!!bulkBusy || tooMany} onClick={() => startBulk("publish")}>{bulkBusy === "publish" ? "公開しています…" : "公開する"}</button>
                <button type="button" className="cw-button" disabled={!!bulkBusy || tooMany} onClick={() => startBulk("unpublish")}>{bulkBusy === "unpublish" ? "戻しています…" : "下書きに戻す"}</button>
                <button type="button" className="cw-button cw-danger-outline" disabled={!!bulkBusy || tooMany} onClick={() => startBulk("remove")}>{bulkBusy === "remove" ? "削除しています…" : "削除する"}</button>
                <button type="button" className="cw-link-button" disabled={!!bulkBusy} onClick={() => { setSelected(new Set()); setBulkErrors(null); selectAll.current?.focus(); }}>選択をやめる</button>
              </span>
            </>}
          </div>}
          {tooMany && <p className="cw-hint cw-warn" role="status">一度に操作できるのは {COLLECTION_BULK_LIMIT} 件までです（いま {chosen.length} 件）。選ぶ数を減らしてください。</p>}
          {bulkErrors && <div className="cw-bulk-errors" role="alert"><p>{bulkFailed[bulkErrors.action]}</p><ul>{bulkErrors.messages.map((message, index) => <li key={`${index}-${message}`}>{message}</li>)}</ul></div>}
          <div className="cw-table" data-lead={lead}>
            <div className="cw-rows-head" aria-hidden="true">{lead && <span />}<span>題名</span><span>状態</span><span>公開日時</span><span>最終更新</span><span /></div>
            <ul className="cw-rows" ref={list} aria-label={`${definition.label}の一覧`} aria-busy={!!pending} data-dragging={drag ? true : undefined}>{visible.map((item) => {
              const sub = item.subtitle ?? item.path, title = item.title || "無題", grabbable = reorderActive && item.order !== null;
              return <li className="cw-row" key={item.id} data-row-id={item.id} data-dragging={drag?.id === item.id ? true : undefined} data-drop={dropSide(item.id)}>
                {lead && <span className="cw-row-lead">
                  {bulk && <label className="cw-check cw-row-check"><input type="checkbox" aria-label={`「${title}」を選ぶ`} checked={selected.has(item.id)} disabled={!!bulkBusy} onChange={(event) => toggle(item.id, event.target.checked)} /></label>}
                  {reorderActive && (grabbable
                    ? <span className="cw-handle" aria-hidden="true" title="ドラッグして並べ替える" data-disabled={pending ? true : undefined}
                      onPointerDown={(event) => grab(event, item.id)} onPointerMove={drift} onPointerUp={release} onPointerCancel={() => { dragging.current = null; setDrag(null); }}><Icon name="grip" /></span>
                    : <span className="cw-handle-slot" aria-hidden="true" />)}
                </span>}
                <button type="button" className="cw-row-open" data-item-id={item.id} onClick={() => onOpen(item.id)}>
                  <span className="cw-thumb" data-shape={shape}><Thumb src={imageSrc(item.imageUrl, 160)} /></span>
                  <span className="cw-row-text"><span className="cw-row-title">{title}</span>{sub && <span className="cw-row-sub">{sub}</span>}</span>
                </button>
                <span className="cw-row-meta">
                  <span className="cw-cell cw-cell-status"><span className="cw-cell-label">状態</span><StatusBadges status={item.status} scheduledAt={item.scheduledAt} publishFailed={item.publishFailed} timeZone={timeZone} /></span>
                  <span className="cw-cell cw-cell-published"><span className="cw-cell-label">公開</span><DateTime value={item.publishedAt} timeZone={timeZone} /></span>
                  <span className="cw-cell cw-cell-updated"><span className="cw-cell-label">最終更新</span><DateTime value={item.updatedAt} timeZone={timeZone} />{item.updatedBy && <span className="cw-by">{item.updatedBy}</span>}</span>
                </span>
                <MenuButton label={`「${title}」の操作`} items={menu(item)} className="cw-row-menu" />
              </li>;
            })}</ul>
          </div>
        </>}
    </>}
  </div>;
}

/* ---------- 項目の編集 ---------- */

type SaveState = "idle" | "pending" | "saving" | "saved" | "error" | "invalid";
type FieldErrors = Readonly<Record<string, { readonly message: string; readonly source: "local" | "server" }>>;
type EditorProps = {
  adapter: CollectionAdapter; definition: CollectionDefinition; itemId: string; created: CollectionItem | null; timeZone: string; autosaveDelay: number;
  renderRichText: ((props: CollectionRichTextEditorProps) => ReactNode) | undefined;
  references: (collectionId: string) => ReferenceCandidates; retryReferences: (collectionId: string) => void;
  confirm: (request: ConfirmRequest) => void;
  /** 削除の移動先にできる、同じコレクションのほかの公開中の項目。 */
  redirectCandidates: () => readonly RedirectCandidate[];
  onSaved: (item: CollectionItem) => void; onBack: () => void; onRemoved: (message: string) => void; onOpenItem: (item: CollectionItem) => void;
};
type Live = {
  item: CollectionItem | null; values: CollectionValues; dirty: boolean; seq: number; saving: Promise<boolean> | null;
  timer: ReturnType<typeof setTimeout> | undefined; blocked: boolean; closed: boolean; uploads: Set<Promise<unknown>>;
};

function safeLink(value: string | null): string | null {
  if (value === null) return null;
  return isDisplayableImageUrl(value) ? value : null;
}

/** 公開中のアドレスの slug（pathPrefix の後ろ）。公開していなければ null。 */
function publishedSlugOf(definition: CollectionDefinition, item: CollectionItem): string | null {
  return item.publishedAt !== null && item.path !== null && definition.pathPrefix !== null && item.path.startsWith(definition.pathPrefix) ? item.path.slice(definition.pathPrefix.length) : null;
}

function ItemEditor({ adapter, definition, itemId, created, timeZone, autosaveDelay, renderRichText, references, retryReferences, confirm, redirectCandidates: candidatesFor, onSaved, onBack, onRemoved, onOpenItem }: EditorProps) {
  const requests = useRequests();
  const baseId = useId();
  const root = useRef<HTMLDivElement>(null), heading = useRef<HTMLHeadingElement>(null), scheduleField = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<"loading" | "error" | "forbidden" | "not_found" | "ready">(created ? "ready" : "loading");
  const [item, setItemState] = useState<CollectionItem | null>(created);
  const [values, setValuesState] = useState<CollectionValues>(created?.values ?? {});
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [conflict, setConflict] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [general, setGeneral] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ readonly text: string; readonly error: boolean } | null>(null);
  const [scheduleInput, setScheduleInput] = useState("");
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  /** 公開中のアドレスを変えたとき、前のアドレスから移すか（capabilities.redirects のときだけ使う）。 */
  const [redirect, setRedirectState] = useState(true);
  const redirectChoice = useRef(true);
  const setRedirect = (checked: boolean) => { redirectChoice.current = checked; setRedirectState(checked); };
  const live = useRef<Live>({ item: created, values: created?.values ?? {}, dirty: false, seq: 0, saving: null, timer: undefined, blocked: false, closed: false, uploads: new Set() });

  const setItem = (next: CollectionItem) => { live.current.item = next; setItemState(next); onSaved(next); };
  const resetTo = (next: CollectionItem) => {
    const s = live.current;
    clearTimeout(s.timer);
    Object.assign(s, { item: next, values: next.values, dirty: false, blocked: false, seq: s.seq + 1 });
    setItemState(next); setValuesState(next.values); setDirty(false); setConflict(false); setErrors({}); setGeneral([]); setSaveState("idle");
    onSaved(next);
  };
  const lose = (status: "forbidden" | "not_found") => {
    const s = live.current;
    clearTimeout(s.timer);
    Object.assign(s, { item: null, values: {}, dirty: false, blocked: true });
    setItemState(null); setValuesState({}); setDirty(false); setBanner(null); setPhase(status);
  };
  const showProblems = (problems: readonly CollectionFieldError[], source: "local" | "server", focus: boolean) => {
    const known = new Set(definition.fields.map((field) => field.key));
    const next: Record<string, { message: string; source: "local" | "server" }> = {}, rest: string[] = [];
    for (const problem of problems) {
      if (!known.has(problem.field)) rest.push(problem.message);
      else if (!next[problem.field]) next[problem.field] = { message: problem.message, source };
    }
    setErrors(next);
    setGeneral(rest);
    const first = definition.fields.find((field) => next[field.key]);
    if (focus && first) focusField(first.key);
  };
  const focusField = (key: string) => {
    const target = document.getElementById(fieldControlId(baseId, key)) ?? root.current?.querySelector<HTMLElement>(`[data-field="${key}"] :is(input,textarea,button,[contenteditable])`);
    target?.focus();
    target?.scrollIntoView?.({ block: "center" });
  };

  const load = async () => {
    setPhase("loading");
    const outcome = await requests.current.run(async (signal) => parseCollectionItemResult(await adapter.loadItem({ collectionId: definition.id, itemId }, signal), definition, itemId));
    if (outcome.kind === "aborted") return;
    if (outcome.kind === "error") { setPhase("error"); return; }
    if (outcome.value.status !== "ready") { lose(outcome.value.status); return; }
    resetTo(outcome.value.item);
    setPhase("ready");
  };
  useEffect(() => {
    const s = live.current;
    s.closed = false;
    if (!created) void load();
    return () => { s.closed = true; clearTimeout(s.timer); };
    // 開いたときに 1 回だけ読む（key で項目ごとに作り直す）
  }, []);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      const s = live.current;
      if (s.dirty || s.saving || s.uploads.size) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);
  const focused = useRef(false);
  useEffect(() => {
    if (phase !== "ready" || focused.current) return;
    focused.current = true;
    if (created) focusField(definition.titleField);
    else heading.current?.focus();
  }, [phase]);

  /* ---------- 保存（下書き・自動） ---------- */
  const save = async (): Promise<boolean> => {
    const s = live.current;
    clearTimeout(s.timer);
    s.timer = undefined;
    if (s.closed || !s.item) return false;
    if (s.saving) {
      if (!(await s.saving)) return false;
      return s.dirty ? save() : true;
    }
    if (s.blocked) return false;
    if (!s.dirty) return true;
    const seq = s.seq, values = s.values, version = s.item.version;
    setSaveState("saving");
    const task = (async (): Promise<boolean> => {
      try {
        const outcome = await requests.current.run(async (signal) => parseCollectionSaveResult(await adapter.saveDraft({ collectionId: definition.id, itemId, version, values }, signal), definition, itemId));
        if (outcome.kind === "aborted") return false;
        if (outcome.kind === "error") { setSaveState("error"); return false; }
        const result = outcome.value;
        if (result.status === "saved") {
          setItem(result.item);
          if (s.seq === seq) { s.dirty = false; setDirty(false); }
          setErrors((previous) => Object.fromEntries(Object.entries(previous).filter(([, error]) => error.source === "local")));
          setGeneral([]);
          setSaveState(s.dirty ? "pending" : "saved");
          return true;
        }
        if (result.status === "conflict") { s.blocked = true; setConflict(true); setSaveState("error"); return false; }
        if (result.status === "invalid") { showProblems(result.errors, "server", false); setSaveState("invalid"); return false; }
        lose(result.status);
        return false;
      } finally { s.saving = null; }
    })();
    s.saving = task;
    return task;
  };
  /** 上げている画像と保存待ちを済ませる。保存できなければ false。 */
  const flush = async (): Promise<boolean> => {
    const s = live.current;
    clearTimeout(s.timer);
    while (s.uploads.size) await Promise.allSettled([...s.uploads]);
    for (let attempt = 0; attempt < 5 && (s.dirty || s.saving); attempt++) {
      if (!(await save())) return false;
    }
    return !s.dirty && !s.blocked && !!s.item;
  };
  const change = (key: string, value: CollectionValue) => {
    const s = live.current;
    if (!s.item) return;
    s.values = { ...s.values, [key]: value };
    s.dirty = true;
    s.seq++;
    setValuesState(s.values);
    setDirty(true);
    setErrors((previous) => {
      if (!previous[key]) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
    if (s.blocked) return;
    setSaveState("pending");
    clearTimeout(s.timer);
    s.timer = setTimeout(() => { void save(); }, autosaveDelay);
  };

  /* ---------- 公開・予約・ほかの操作 ---------- */
  const titleText = () => { const value = live.current.values[definition.titleField]; return typeof value === "string" && value.trim() ? value.trim() : "無題"; };
  /** 公開・予約に付ける redirect。転送できるホストで、公開中のアドレスを変えたときだけ付ける。 */
  const redirectFor = (current: CollectionItem, values: CollectionValues): { readonly redirect?: boolean } => {
    if (!definition.capabilities.redirects || definition.slugField === null) return {};
    const slug = publishedSlugOf(definition, current), next = values[definition.slugField];
    return slug !== null && typeof next === "string" && next !== slug ? { redirect: redirectChoice.current } : {};
  };
  const publish = async () => {
    const s = live.current;
    if (busy || !s.item || s.blocked) return;
    const problems = validateCollectionValues(definition, s.values);
    if (problems.length) { showProblems(problems, "local", true); setBanner({ text: "公開できません。印のついた項目を直してください。", error: true }); return; }
    setBusy("publish");
    setBanner(null);
    try {
      if (!(await flush())) { if (!s.blocked && s.item) setBanner({ text: "保存できないため、公開しませんでした。", error: true }); return; }
      const version = s.item!.version, moveOld = redirectFor(s.item!, s.values);
      const outcome = await requests.current.run(async (signal) => parseCollectionPublishResult(await adapter.publish({ collectionId: definition.id, itemId, version, ...moveOld }, signal), definition, itemId));
      if (outcome.kind === "aborted") return;
      if (outcome.kind === "error") { setBanner({ text: "公開できませんでした。もう一度試してください。", error: true }); return; }
      const result = outcome.value;
      if (result.status === "published" || result.status === "publishing") {
        setItem(result.item);
        setRedirect(true);
        setBanner({ text: result.status === "publishing" ? "公開しました。サイトに出るまで少しかかります。" : "公開しました。", error: false });
      } else if (result.status === "conflict") { s.blocked = true; setConflict(true); }
      else if (result.status === "invalid") { showProblems(result.errors, "server", true); setBanner({ text: "公開できません。印のついた項目を直してください。", error: true }); }
      else lose(result.status);
    } finally { setBusy(null); }
  };
  /** 保存の結果（saved）を返す操作。keepEdits が false なら、まだ保存していない変更を捨てる。 */
  const mutate = async (kind: string, call: (version: string, signal: AbortSignal) => Promise<unknown>, success: string, keepEdits: boolean): Promise<boolean> => {
    const s = live.current;
    if (!s.item) return false;
    setBusy(kind);
    setBanner(null);
    try {
      if (keepEdits) {
        if (!(await flush())) { if (!s.blocked && s.item) setBanner({ text: "保存できないため、操作しませんでした。", error: true }); return false; }
      } else {
        clearTimeout(s.timer);
        if (s.saving) await s.saving;
      }
      if (!s.item) return false;
      const version = s.item.version;
      const outcome = await requests.current.run(async (signal) => parseCollectionSaveResult(await call(version, signal), definition, itemId));
      if (outcome.kind === "aborted") return false;
      if (outcome.kind === "error") { setBanner({ text: "操作できませんでした。もう一度試してください。", error: true }); return false; }
      const result = outcome.value;
      if (result.status === "saved") {
        if (keepEdits) setItem(result.item); else resetTo(result.item);
        setBanner({ text: success, error: false });
        return true;
      }
      if (result.status === "conflict") { s.blocked = true; setConflict(true); }
      else if (result.status === "invalid") { showProblems(result.errors, "server", true); setBanner({ text: "この操作はできません。印のついた項目を直してください。", error: true }); }
      else lose(result.status);
      return false;
    } finally { setBusy(null); }
  };
  const reloadLatest = async () => {
    setBusy("reload");
    try {
      const outcome = await requests.current.run(async (signal) => parseCollectionItemResult(await adapter.loadItem({ collectionId: definition.id, itemId }, signal), definition, itemId));
      if (outcome.kind === "aborted") return;
      if (outcome.kind === "error") { setBanner({ text: "読み込めませんでした。もう一度試してください。", error: true }); return; }
      if (outcome.value.status !== "ready") { lose(outcome.value.status); return; }
      resetTo(outcome.value.item);
      setBanner({ text: "最新の内容を読み込みました。", error: false });
    } finally { setBusy(null); }
  };
  const removeItem = async (redirectTo: RedirectTo) => {
    const s = live.current;
    if (!s.item || !adapter.remove) return;
    setBusy("remove");
    setBanner(null);
    try {
      clearTimeout(s.timer);
      if (s.saving) await s.saving;
      if (!s.item) return;
      const version = s.item.version;
      const outcome = await requests.current.run(async (signal) => parseCollectionRemoveResult(await adapter.remove!({ collectionId: definition.id, itemId, version, ...redirectInput(redirectTo) }, signal), definition, itemId));
      if (outcome.kind === "aborted") return;
      if (outcome.kind === "error") { setBanner({ text: "削除できませんでした。もう一度試してください。", error: true }); return; }
      const result = outcome.value;
      if (result.status === "removed" || result.status === "not_found") {
        Object.assign(s, { dirty: false, blocked: true });
        onRemoved(result.status === "removed" ? "削除しました。" : "すでに削除されていました。");
      } else if (result.status === "conflict") { s.blocked = true; setConflict(true); }
      else if (result.status === "invalid") setBanner({ text: `削除できませんでした。${messagesOf(result.errors).join(" ")}`, error: true });
      else lose(result.status);
    } finally { setBusy(null); }
  };
  const duplicate = async () => {
    if (!adapter.duplicate) return;
    setBusy("duplicate");
    try {
      if (!(await flush())) { if (!live.current.blocked && live.current.item) setBanner({ text: "保存できないため、複製しませんでした。", error: true }); return; }
      const outcome = await requests.current.run(async (signal) => parseCollectionCreateResult(await adapter.duplicate!({ collectionId: definition.id, itemId }, signal), definition));
      if (outcome.kind === "aborted") return;
      if (outcome.kind === "error") { setBanner({ text: "複製できませんでした。もう一度試してください。", error: true }); return; }
      if (outcome.value.status === "created") onOpenItem(outcome.value.item);
      else lose(outcome.value.status);
    } finally { setBusy(null); }
  };
  const scheduleIt = async () => {
    const schedule = adapter.schedule;
    if (!schedule) return;
    const at = collectionDateFromInput(scheduleInput, timeZone);
    if (!at || Date.parse(at) <= Date.now()) { setScheduleError("これから先の日時を選んでください。"); scheduleField.current?.focus(); return; }
    setScheduleError(null);
    const problems = validateCollectionValues(definition, live.current.values);
    if (problems.length) { showProblems(problems, "local", true); setBanner({ text: "予約できません。印のついた項目を直してください。", error: true }); return; }
    const done = await mutate("schedule", (version, signal) => schedule.call(adapter, { collectionId: definition.id, itemId, version, at, ...(live.current.item ? redirectFor(live.current.item, live.current.values) : {}) }, signal), `予約しました。${formatDateTime(at, timeZone)}（${zoneLabel(timeZone)}）に公開します。`, true);
    if (done) setScheduleInput("");
  };
  const back = async () => {
    if (busy === "back") return;
    setBusy("back");
    const ok = await flush();
    setBusy(null);
    if (ok) { onBack(); return; }
    confirm({
      title: "保存できていない変更があります", body: "一覧へ戻ると、この画面でいま直したところは消えます。", confirmLabel: "変更を捨てて戻る", tone: "danger",
      run: () => { const s = live.current; clearTimeout(s.timer); Object.assign(s, { dirty: false, blocked: true }); onBack(); },
    });
  };

  if (phase !== "ready" || !item) {
    return <div className="cw-editor" ref={root}>
      <header className="cw-editor-bar"><button type="button" className="cw-back" onClick={onBack}><Icon name="back" /><span className="cw-back-label">一覧へ</span></button></header>
      {phase === "not_found" ? <div className="cw-notice"><p role="alert">この{definition.label}は見つかりませんでした。削除されたかもしれません。</p></div>
        : <Notice status={phase === "ready" ? "loading" : phase} noun={definition.label} retry={() => void load()} />}
    </div>;
  }

  // 公開の要求（commit を含み数十秒かかることがある）の間は、直前に保存した下書きの「変更あり」ではなく「反映中」を出す（kamakura-site#155）
  const status: CollectionItemStatus = busy === "publish" ? "publishing" : dirty && item.status === "published" ? "changed" : item.status;
  const capabilities = definition.capabilities;
  const menu: MenuItem[] = [];
  if (status === "changed" && adapter.discardDraft) menu.push({ label: "変更を取り消す", onSelect: () => confirm({
    title: "変更を取り消しますか？", body: "公開中の内容に戻ります。取り消した変更は元に戻せません。", confirmLabel: "変更を取り消す", tone: "danger",
    run: async () => { await mutate("discard", (version, signal) => adapter.discardDraft!({ collectionId: definition.id, itemId, version }, signal), "変更を取り消しました。公開中の内容に戻しました。", false); },
  }) });
  if (capabilities.unpublish && adapter.unpublish && (status === "published" || status === "changed")) menu.push({ label: "非公開にする", onSelect: () => confirm({
    title: `「${titleText()}」を非公開にしますか？`, body: "サイトから外れます。もう一度公開するまで、このアドレスは開けなくなります。", confirmLabel: "非公開にする", tone: "danger",
    run: async () => { await mutate("unpublish", (version, signal) => adapter.unpublish!({ collectionId: definition.id, itemId, version }, signal), "非公開にしました。サイトから外れるまで少しかかります。", true); },
  }) });
  if (capabilities.duplicate && adapter.duplicate) menu.push({ label: "複製する", onSelect: () => void duplicate() });
  if (capabilities.remove && adapter.remove) menu.push({ label: "削除する", danger: true, onSelect: () => confirm(removeConfirm(definition, titleText(), { path: item.path, status: item.status }, candidatesFor(), removeItem)) });
  const primary = busy === "publish" ? { label: "公開しています…", disabled: true }
    : status === "published" ? { label: "公開中", disabled: true }
    : status === "publishing" && !dirty ? { label: "反映中", disabled: true }
    : { label: status === "changed" || status === "publishing" ? "変更を公開する" : "公開する", disabled: conflict || !!busy };
  const saveText = saveState === "pending" || saveState === "saving" ? "保存中…" : saveState === "saved" ? "保存しました"
    : saveState === "invalid" ? "保存できませんでした（直すところがあります）" : saveState === "error" ? conflict ? "保存していません" : "保存できませんでした" : "";
  let preview: string | null = null;
  try { preview = adapter.previewUrl ? safeLink(adapter.previewUrl(definition.id, item)) : null; } catch { preview = null; }
  const slugValue = definition.slugField ? values[definition.slugField] : null;
  const address = definition.pathPrefix !== null && definition.slugField !== null
    ? typeof slugValue === "string" && slugValue.trim() ? `${definition.pathPrefix}${slugValue.trim()}` : null
    : item.path;
  const publishedSlug = publishedSlugOf(definition, item);
  const sanitize = (html: string) => sanitizeRichTextHtml(html, adapter.isRichTextImageAllowed ? { isImageSrcAllowed: (src) => adapter.isRichTextImageAllowed!(src) } : {});
  const upload: FieldContext["upload"] = async (file) => {
    const s = live.current;
    const task = requests.current.run(async (signal) => parseCollectionUploadResult(await adapter.uploadImage({ collectionId: definition.id, file }, signal)));
    s.uploads.add(task);
    try {
      const outcome = await task;
      if (outcome.kind !== "ok") return { error: rejectMessages.failed };
      if (outcome.value.status === "rejected") return { error: rejectMessages[outcome.value.reason] };
      const { url, width, height } = outcome.value;
      return { url, ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }) };
    } finally { s.uploads.delete(task); }
  };
  const context: FieldContext = {
    baseId, timeZone, pathPrefix: definition.pathPrefix, isTitle: false, publishedSlug, self: { collectionId: definition.id, itemId },
    redirect: capabilities.redirects && publishedSlug !== null && item.path !== null ? { from: item.path, checked: redirect, onChange: setRedirect } : null,
    imageSrc: (url, width) => displayImage(url, width, adapter.imageUrl ? (value, size) => adapter.imageUrl!(value, size) : undefined),
    upload, references, retryReferences, renderRichText, sanitize,
  };
  const fieldNode = (field: CollectionDefinition["fields"][number]) => <FieldView key={field.key} field={field} value={values[field.key]} error={errors[field.key]?.message}
    context={field.key === definition.titleField ? { ...context, isTitle: true } : context} onChange={(value) => change(field.key, value)} />;
  const mainFields = definition.fields.filter((field) => field.placement === "main"), sideFields = definition.fields.filter((field) => field.placement === "side");
  const canSchedule = capabilities.schedule && !!adapter.schedule;
  const canRetry = !!capabilities.retrySchedule && !!adapter.retrySchedule && item.scheduledAt !== null && item.publishFailed;

  return <div className="cw-editor" ref={root}>
    <h2 className="cw-sr" tabIndex={-1} ref={heading}>{`${definition.label}「${titleText()}」の編集`}</h2>
    <header className="cw-editor-bar">
      <button type="button" className="cw-back" onClick={() => void back()} disabled={busy === "back"}><Icon name="back" /><span className="cw-back-label">一覧へ</span></button>
      <div className="cw-editor-status">
        <StatusBadges status={status} scheduledAt={item.scheduledAt} publishFailed={item.publishFailed} timeZone={timeZone} />
        <span className="cw-save-state" role="status">{saveText}</span>
        {(saveState === "error" || saveState === "invalid") && !conflict && <button type="button" className="cw-link-button" onClick={() => void save()}>再試行</button>}
      </div>
      <div className="cw-editor-actions">
        {preview && <a className="cw-button" href={preview} target="_blank" rel="noopener noreferrer">プレビュー<span className="cw-sr">（新しいタブで開く）</span></a>}
        <MenuButton label="その他の操作" items={menu} />
        <button type="button" className="cw-button cw-primary" disabled={primary.disabled} onClick={() => void publish()}>{primary.label}</button>
      </div>
    </header>
    {conflict && <div className="cw-banner" data-tone="error" role="alert">
      <p><strong>ほかの人が先に保存しました。</strong>この画面の変更は保存していません。「最新を読み込む」と、ほかの人が保存した内容を開きます（この画面でいま直したところは消えます）。</p>
      <button type="button" className="cw-button" disabled={busy === "reload"} onClick={() => void reloadLatest()}>最新を読み込む</button>
    </div>}
    {banner && <div className="cw-banner" data-tone={banner.error ? "error" : "info"} role={banner.error ? "alert" : "status"}>
      <p>{banner.text}</p><button type="button" className="cw-icon-button" aria-label="知らせを閉じる" onClick={() => setBanner(null)}><Icon name="close" /></button>
    </div>}
    {general.length > 0 && <div className="cw-banner" data-tone="error" role="alert"><ul>{general.map((message) => <li key={message}>{message}</li>)}</ul></div>}
    <div className="cw-editor-body">
      <div className="cw-editor-main"><div className="cw-card">{mainFields.map(fieldNode)}</div></div>
      <aside className="cw-editor-side" aria-label={`${definition.label}の公開と設定`}>
        <section className="cw-side-section" aria-labelledby={`${baseId}-publish`}>
          <h3 id={`${baseId}-publish`}>公開</h3>
          <dl className="cw-facts">
            <div><dt>状態</dt><dd><StatusBadges status={status} scheduledAt={item.scheduledAt} publishFailed={item.publishFailed} timeZone={timeZone} /></dd></div>
            <div><dt>公開日時</dt><dd><DateTime value={item.publishedAt} timeZone={timeZone} empty="まだ公開していません" /></dd></div>
            <div><dt>最終更新</dt><dd><DateTime value={item.updatedAt} timeZone={timeZone} />{item.updatedBy && <span className="cw-by"> · {item.updatedBy}</span>}</dd></div>
            {(definition.slugField !== null || item.path !== null) && <div><dt>アドレス</dt><dd className="cw-address">{address ?? "まだ決まっていません"}</dd></div>}
          </dl>
          {canSchedule && (item.scheduledAt !== null
            ? <div className="cw-schedule"><p><strong>公開予定</strong> <time dateTime={item.scheduledAt}>{formatDateTime(item.scheduledAt, timeZone)}</time>（{zoneLabel(timeZone)}）</p>
              {canRetry && <p className="cw-error"><Icon name="alert" />予約していた公開に失敗しました。</p>}
              <div className="cw-inline">
                {canRetry && <button type="button" className="cw-button cw-primary" disabled={!!busy || conflict} onClick={() => void mutate("retrySchedule", (version, signal) => adapter.retrySchedule!({ collectionId: definition.id, itemId, version }, signal), "予約していた公開をやり直しました。", true)}>{busy === "retrySchedule" ? "やり直しています…" : "もう一度公開する"}</button>}
                {adapter.cancelSchedule && <button type="button" className="cw-button" disabled={!!busy || conflict} onClick={() => void mutate("cancelSchedule", (version, signal) => adapter.cancelSchedule!({ collectionId: definition.id, itemId, version }, signal), "予約を取り消しました。", true)}>予約を取り消す</button>}
              </div></div>
            : <div className="cw-schedule">
              <label className="cw-label" htmlFor={`${baseId}-schedule`}>予約して公開する日時</label>
              <p className="cw-hint" id={`${baseId}-schedule-hint`}>{zoneLabel(timeZone)}で入力します。保存した下書きを、その日時に公開します。</p>
              <div className="cw-inline">
                <input ref={scheduleField} id={`${baseId}-schedule`} type="datetime-local" className="cw-input" value={scheduleInput}
                  aria-describedby={`${baseId}-schedule-hint${scheduleError ? ` ${baseId}-schedule-error` : ""}`} aria-invalid={scheduleError ? true : undefined}
                  onChange={(event) => { setScheduleInput(event.target.value); setScheduleError(null); }} />
                <button type="button" className="cw-button" disabled={!scheduleInput || !!busy || conflict} onClick={() => void scheduleIt()}>予約する</button>
              </div>
              {scheduleError && <p className="cw-error" id={`${baseId}-schedule-error`}><Icon name="alert" />{scheduleError}</p>}
            </div>)}
        </section>
        {sideFields.length > 0 && <section className="cw-side-section cw-side-fields" aria-label="項目">{sideFields.map(fieldNode)}</section>}
      </aside>
    </div>
  </div>;
}
