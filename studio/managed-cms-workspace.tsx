import { useEffect, useRef, useState } from "react";
import type { CmsCollection, CmsDiscovery, CmsItemRevision, CmsReleasePin, CmsReleaseSnapshot, CmsSchema } from "../src/cms-v2.js";
import { collectionPathForEditor, starterCollection } from "./managed-cms-model.js";
import type { CollectionValues, CollectionValue } from "../src/collection-model.js";

export type ManagedCmsWorkspaceProps = { readonly projectId: string; readonly siteId: string; readonly origin: string | null };
type ItemSummary = { id: string; title: string; revision: string; removedAt: string | null; scheduleId: string | null; status: string; scheduledAt: string | null };
type List = { items: ItemSummary[]; nextCursor: string | null };
type ItemRead = { item: CmsItemRevision; summary: ItemSummary };
type Current = { snapshot: CmsReleaseSnapshot | null; locale: string; collectionRoot: string };
type Confirmation = { operationId: string; confirmationToken: string };
type Preview = { title: string; fields: { label: string; text: string }[] };
type Settings = { schema: CmsSchema; current: Current; owner: boolean };

class RequestFailed extends Error {
  constructor(readonly status: number, readonly explanation: string | null) { super("CMS request failed"); }
}
function failureMessage(error: unknown) {
  if (!(error instanceof RequestFailed)) return "CMS を読み込めませんでした。時間をおいて再度お試しください。";
  if (error.explanation) return error.explanation;
  if (error.status === 401) return "セッションが切れました。ページを読み込み直してください。";
  if (error.status === 403) return "この操作を行う権限がありません。";
  if (error.status === 409) return "編集中に内容が更新されました。一覧を更新して操作をやり直してください。";
  return "操作が完了しませんでした。内容を確認して再度お試しください。";
}

const STATUS: Readonly<Record<string, string>> = {
  draft: "下書き", published: "公開中", changed: "変更あり", publishing: "反映中", scheduled: "予約済み"
};
const sameItem = (a: CmsReleasePin, b: CmsReleasePin) => a.collectionId === b.collectionId && a.itemId === b.itemId;

export function ManagedCmsWorkspace({ projectId, siteId, origin }: ManagedCmsWorkspaceProps) {
  const base = `/api/projects/${projectId}/sites/${siteId}/cms/v2`;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [collectionId, setCollectionId] = useState("");
  const [deleted, setDeleted] = useState(false);
  const [list, setList] = useState<List>({ items: [], nextCursor: null });
  const [item, setItem] = useState<CmsItemRevision | null>(null);
  const [itemStatus, setItemStatus] = useState<ItemSummary | null>(null);
  const [values, setValues] = useState<CollectionValues>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [at, setAt] = useState("");
  const [newCollection, setNewCollection] = useState({ label: "", slug: "" });
  const [busy, setBusy] = useState(false);
  const pendingKeys = useRef(new Map<string, string>());
  const pendingPlans = useRef(new Map<string, Confirmation>());
  const [feedback, setFeedback] = useState("");
  const currentCollection = settings?.schema.collections.find(({ id }) => id === collectionId);
  const dirty = item !== null && JSON.stringify(item.values) !== JSON.stringify(values);

  async function call<T>(operation: string, input?: Record<string, unknown>, keyed = false, signal?: AbortSignal): Promise<T> {
    const signature = JSON.stringify([operation, input]);
    const operationId = keyed ? pendingKeys.current.get(signature) ?? crypto.randomUUID() : null;
    if (operationId) pendingKeys.current.set(signature, operationId);
    const response = await fetch(`${base}/${operation}`, input === undefined ? { signal: signal ?? null, cache: "no-store" } : {
      method: "POST", cache: "no-store", signal: signal ?? null,
      headers: { "Content-Type": "application/json", ...(operationId ? { "X-Studio-Operation-Key": operationId } : {}) },
      body: JSON.stringify({ siteId, ...input })
    });
    const result = await response.json().catch(() => null);
    if (response.status < 500 && result !== null) pendingKeys.current.delete(signature);
    if (!response.ok) throw new RequestFailed(response.status, result?.problems?.[0]?.message ?? null);
    if (result === null) throw new RequestFailed(503, null);
    return result as T;
  }

  async function applyPlan<T>(signature: string, operation: string, prepare: () => Promise<Confirmation>) {
    const plan = pendingPlans.current.get(signature) ?? await prepare();
    pendingPlans.current.set(signature, plan);
    try {
      const result = await call<T>(operation, { operationId: plan.operationId, confirmationToken: plan.confirmationToken });
      pendingPlans.current.delete(signature);
      return { plan, result };
    } catch (error) {
      if (error instanceof RequestFailed && error.status < 500) pendingPlans.current.delete(signature);
      throw error;
    }
  }

  async function loadList(id: string, removed: boolean, cursor?: string, signal?: AbortSignal) {
    if (!id) { setList({ items: [], nextCursor: null }); return; }
    const result = await call<List>("cms.items.list", { collectionId: id, deleted: removed, ...(cursor ? { cursor } : {}) }, undefined, signal);
    if (!signal?.aborted) setList((previous) => ({ items: cursor ? [...previous.items, ...result.items] : result.items, nextCursor: result.nextCursor }));
  }

  async function loadSettings(signal?: AbortSignal) {
    const [discovery, schema, current] = await Promise.all([
      call<CmsDiscovery>("discover", undefined, undefined, signal), call<CmsSchema>("cms.schema.read", {}, undefined, signal),
      call<Current>("cms.release.current", {}, undefined, signal)
    ]);
    const next = { schema, current, owner: discovery.contractVersion === 2 && discovery.operations.includes("cms.schema.apply") };
    if (!signal?.aborted) setSettings(next);
    return next;
  }

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setBusy(true);
      try {
        const next = await loadSettings(controller.signal);
        if (controller.signal.aborted) return;
        const id = next.schema.collections[0]?.id ?? "";
        setCollectionId(id);
        await loadList(id, false, undefined, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) setFeedback(failureMessage(error));
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    })();
    return () => controller.abort();
  }, [base]);

  function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setFeedback("");
    void action().catch((error) => setFeedback(failureMessage(error))).finally(() => setBusy(false));
  }
  function showItem(next: CmsItemRevision | null, summary: ItemSummary | null = null) {
    setItem(next); setItemStatus(summary); setValues(next?.values ?? {}); setPreview(null); setAt("");
  }
  async function readItem(id: string) {
    return call<ItemRead>("cms.items.read", { collectionId, itemId: id });
  }
  async function refresh() {
    const next = await loadSettings();
    const id = next.schema.collections.some(({ id }) => id === collectionId) ? collectionId : next.schema.collections[0]?.id ?? "";
    if (id !== collectionId) { showItem(null); setCollectionId(id); }
    await loadList(id, deleted);
    if (item && id === collectionId) setItemStatus((await readItem(item.itemId)).summary);
  }
  async function create() {
    const next = await call<{ item: CmsItemRevision }>("cms.items.create",
      { collectionId, contractVersion: 2, expectedSchemaRevision: settings!.schema.schemaRevision }, true);
    showItem(next.item, { id: next.item.itemId, title: "", revision: next.item.revision, removedAt: null, scheduleId: null, status: "draft", scheduledAt: null });
    await loadList(collectionId, false);
  }
  async function save() {
    const { itemId, revision, locale, schemaRevision } = item!;
    const next = await call<{ item: CmsItemRevision }>("cms.items.save",
      { collectionId, itemId, locale, contractVersion: 2, expectedSchemaRevision: schemaRevision, expectedRevision: revision, values }, true);
    showItem(next.item, itemStatus ? { ...itemStatus, revision: next.item.revision, status: itemStatus.status === "published" ? "changed" : itemStatus.status } : null);
    await loadList(collectionId, false);
    setFeedback("下書きを保存しました。");
  }
  async function release(withdraw: boolean, scheduled = false) {
    const draft = item!, operation = scheduled ? "cms.schedule.create" : "cms.release.apply";
    const signature = JSON.stringify([operation, draft.revision, withdraw, scheduled ? at : null]);
    const { plan, result } = await applyPlan<{ result: { releaseId: string; scheduleId?: string } }>(signature, operation, async () => {
      const now = await call<Current>("cms.release.current", {}), snapshot = now.snapshot;
      const selected = (snapshot?.items ?? []).filter((pin) => !sameItem(pin, draft));
      const pins = await Promise.all(selected.map(async ({ revision, itemId, collectionId, values }) => {
        if (snapshot?.schema.schemaRevision === draft.schemaRevision) return { revision, itemId, collectionId };
        const latest = (await call<{ item: CmsItemRevision }>("cms.items.read", { collectionId, itemId })).item;
        if (JSON.stringify(latest.values) !== JSON.stringify(values)) {
          throw new RequestFailed(409, "定義の更新前に公開した内容があります。現在の定義で公開する項目を確認してください。");
        }
        return { revision: latest.revision, itemId, collectionId };
      }));
      if (!withdraw) pins.push({ itemId: draft.itemId, collectionId, revision: draft.revision });
      const oldPath = snapshot?.items.find((pin) => sameItem(pin, draft))?.path;
      const path = collectionPathForEditor(currentCollection!, draft.values);
      const redirects = (snapshot?.redirects ?? []).filter((value) => value.to !== oldPath || !withdraw && oldPath === path);
      const input = { locale: now.locale, schemaRevision: draft.schemaRevision, expectedReleaseId: snapshot?.releaseId ?? null, items: pins, redirects,
        ...(scheduled ? { at: new Date(at).toISOString() } : {}) };
      return (await call<{ plan: Confirmation }>("cms.release.plan", input)).plan;
    });
    await refresh();
    if (scheduled) {
      const status = await call<{ status: string }>("cms.schedule.status", { scheduleId: result.result.scheduleId! });
      setFeedback(status.status === "scheduled" ? "公開を予約しました。" : status.status === "released" ? "予約した公開が反映されました。" : "予約した公開に失敗しました。公開内容を確認して再計画してください。");
      return;
    }
    const status = await call<{ delivery: { state: string } }>("cms.release.status", { operationId: plan.operationId });
    setFeedback(status.delivery.state === "delivered" ? withdraw ? "公開を取り下げました。" : "公開しました。"
      : status.delivery.state === "dead" ? "公開に失敗しました。公開中の内容は維持されています。" : "公開の反映を待っています。");
  }
  async function remove(summary: ItemSummary, restore: boolean) {
    const { schema, current } = settings!;
    await call(restore ? "cms.items.restore" : "cms.items.remove",
      { collectionId, itemId: summary.id, expectedRevision: summary.revision, locale: current.locale,
        contractVersion: 2, expectedSchemaRevision: schema.schemaRevision }, true);
    showItem(null);
    await loadList(collectionId, deleted);
    setFeedback(restore ? "下書きへ復元しました。" : "ごみ箱へ移しました。");
  }
  async function addCollection() {
    const { schema } = settings!;
    const definition = starterCollection(newCollection.slug, newCollection.label, `/cms/${newCollection.slug}/`);
    await applyPlan(JSON.stringify(["cms.schema.apply", schema.schemaRevision, newCollection]), "cms.schema.apply",
      async () => (await call<{ plan: Confirmation }>("cms.schema.plan", {
        expectedSchemaRevision: schema.schemaRevision, nextSchema: { ...schema, collections: [...schema.collections, definition] }, replacements: []
      })).plan);
    await loadSettings();
    setNewCollection({ label: "", slug: "" });
    await selectCollection(definition.id);
    setFeedback("コレクションを追加しました。");
  }
  async function selectCollection(id: string) {
    showItem(null); setCollectionId(id); setDeleted(false);
    await loadList(id, false);
  }

  return <section className="studio-native-cms" aria-label="CMS">
    {feedback && <p role="status">{feedback}</p>}
    {!settings ? busy ? <p role="status">CMS を読み込んでいます…</p> : <button onClick={() => run(refresh)}>再読み込み</button> : <>
      <div className="studio-site-hub-actions">
        <label>コレクション <select value={collectionId} disabled={busy || !settings.schema.collections.length}
          onChange={(event) => { const id = event.target.value; run(() => selectCollection(id)); }}>
          {settings.schema.collections.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        </select></label>
        <button disabled={busy} onClick={() => run(refresh)}>一覧を更新</button>
        {origin && settings.current.snapshot && <a href={origin + settings.current.collectionRoot} target="_blank" rel="noreferrer">公開ページを開く</a>}
      </div>
      {settings.owner && <details>
        <summary>コレクションを追加</summary>
        <form onSubmit={(event) => { event.preventDefault(); run(addCollection); }}>
          <label>コレクション名 <input value={newCollection.label} maxLength={80} required onChange={(event) =>
            setNewCollection({ ...newCollection, label: event.target.value })} /></label>
          <label>URL に使う名前 <input value={newCollection.slug} pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={44} required onChange={(event) =>
            setNewCollection({ ...newCollection, slug: event.target.value })} /></label>
          <button disabled={busy}>追加</button>
        </form>
      </details>}
      {currentCollection && <div className="studio-native-cms-columns">
        <div>
          <div className="studio-site-hub-actions">
            <button disabled={busy} aria-pressed={deleted} onClick={() => run(async () => {
              showItem(null); setDeleted(!deleted); await loadList(collectionId, !deleted);
            })}>{deleted ? "項目一覧に戻る" : "ごみ箱"}</button>
            {!deleted && currentCollection.capabilities.create && <button disabled={busy} onClick={() => run(create)}>項目を追加</button>}
          </div>
          {list.items.length === 0 && <p>{deleted ? "ごみ箱は空です。" : "項目がありません。"}</p>}
          <ul aria-label={deleted ? "ごみ箱" : "項目一覧"}>
            {list.items.map((summary) => <li key={summary.id}>
              {deleted ? <><span>{summary.title || "無題"}</span> <button disabled={busy} onClick={() => run(() => remove(summary, true))}>復元</button></>
                : <button disabled={busy} aria-current={item?.itemId === summary.id ? "true" : undefined}
                  onClick={() => run(async () => {
                    const selected = await readItem(summary.id);
                    showItem(selected.item, selected.summary);
                  })}>
                  {summary.title || "無題"} <small>{STATUS[summary.status]}{summary.scheduledAt ? "・予約あり" : ""}</small>
                </button>}
            </li>)}
          </ul>
          {list.nextCursor && <button disabled={busy} onClick={() => run(() => loadList(collectionId, deleted, list.nextCursor!))}>次の項目を表示</button>}
        </div>
        {item && <div className="studio-native-cms-item">
          <form onSubmit={(event) => { event.preventDefault(); run(save); }}>
            {currentCollection.fields.map((field) => <CmsFieldEditor key={field.fieldId} field={field} value={values[field.fieldId] ?? null}
              update={(value) => setValues({ ...values, [field.fieldId]: value })} />)}
            <button disabled={busy || !dirty}>下書きを保存</button>
          </form>
          <div className="studio-site-hub-actions">
            <button disabled={busy || dirty} onClick={() => run(async () => {
              const { previewId } = await call<{ previewId: string }>("cms.preview.prepare",
                { collectionId, itemId: item.itemId, revision: item.revision });
              setPreview((await call<{ preview: Preview }>("cms.preview.read", { previewId })).preview);
            })}>下書きをプレビュー</button>
            <button disabled={busy || dirty} onClick={() => run(() => release(false))}>公開する</button>
            {settings.current.snapshot?.items.some((pin) => sameItem(pin, item)) &&
              <button disabled={busy} onClick={() => run(() => release(true))}>公開を取り下げる</button>}
          </div>
          {preview && <section aria-label="下書きプレビュー">
            <h2>{preview.title || "無題"}</h2>
            {preview.fields.map(({ label, text }, index) => <div key={index}><strong>{label}</strong><p>{text}</p></div>)}
            <button type="button" onClick={() => setPreview(null)}>プレビューを閉じる</button>
          </section>}
          {currentCollection.capabilities.schedule && <form onSubmit={(event) => { event.preventDefault(); run(() => release(false, true)); }}>
            <label>公開日時 <input type="datetime-local" required value={at} onChange={(event) => setAt(event.target.value)} /></label>
            <button disabled={busy || dirty || itemStatus?.scheduleId != null}>公開を予約</button>
          </form>}
          {itemStatus && <div className="studio-site-hub-actions">
            {itemStatus.scheduleId && <button disabled={busy} onClick={() => run(async () => {
              await call("cms.schedule.cancel", { scheduleId: itemStatus.scheduleId }, true);
              await refresh();
              setFeedback("予約を取り消しました。");
            })}>予約を取り消す</button>}
            {itemStatus.status === "draft" && !itemStatus.scheduleId && currentCollection.capabilities.remove &&
              <button disabled={busy || dirty} onClick={() => run(() => remove(itemStatus, false))}>ごみ箱へ移す</button>}
          </div>}
        </div>}
      </div>}
    </>}
  </section>;
}

function CmsFieldEditor({ field, value, update }: { field: CmsCollection["fields"][number]; value: CollectionValue; update: (value: CollectionValue) => void }) {
  const text = typeof value === "string" ? value : "";
  if (field.type === "longText" || field.type === "richText") return <label>{field.label}
    <textarea value={text} rows={field.type === "longText" ? field.rows : 6} onChange={(event) => update(event.target.value)} />
  </label>;
  if (["text", "slug", "url", "datetime"].includes(field.type)) return <label>{field.label}
    <input value={text} onChange={(event) => update(field.type === "datetime" && !event.target.value ? null : event.target.value)} />
  </label>;
  return <JsonFieldEditor key={JSON.stringify(value)} label={field.label} value={value} update={update} />;
}

function JsonFieldEditor({ label, value, update }: { label: string; value: CollectionValue; update: (value: CollectionValue) => void }) {
  const [text, setText] = useState(JSON.stringify(value));
  return <label>{label} <textarea value={text} onChange={(event) => {
    const next = event.target.value;
    setText(next);
    try {
      update(JSON.parse(next) as CollectionValue);
      event.target.setCustomValidity("");
    } catch {
      event.target.setCustomValidity("有効な JSON を入力してください。");
    }
  }} /></label>;
}
