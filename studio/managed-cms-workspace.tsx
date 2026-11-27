import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { cmsLocalizationItemKey, type CmsCollection, type CmsDiscovery, type CmsItemRevision, type CmsProblem, type CmsReleasePin, type CmsReleaseSnapshot, type CmsSchema } from "../src/cms-v2.js";
import { cmsDraftMatchesPublishedValues, collectionPathForEditor, redirectsForCmsRelease, starterCollection } from "./managed-cms-model.js";
import type { CollectionFieldType, CollectionValues, CollectionValue } from "../src/collection-model.js";

const ManagedCmsTranslation = lazy(() => import("./managed-cms-localization-workspace.js").then((module) => ({ default: module.ManagedCmsTranslation })));

export type ManagedCmsWorkspaceProps = { readonly projectId: string; readonly siteId: string; readonly origin: string | null };
type ItemSummary = { id: string; title: string; revision: string; removedAt: string | null; scheduleId: string | null; status: string; scheduledAt: string | null };
type List = { items: ItemSummary[]; nextCursor: string | null };
type ItemRead = { item: CmsItemRevision; summary: ItemSummary };
type Current = { snapshot: CmsReleaseSnapshot | null; locale: string; routeTableRevision: string; collectionRoot: string };
type Confirmation = { operationId: string; confirmationToken: string };
type SchemaPlan = Confirmation & { candidate: { schema: CmsSchema; changes: { collectionId: string; fieldId: string; kind: "add" | "rename" | "convert" | "remove" }[]; items: unknown[]; removedItems: unknown[] } };
type Preview = { title: string; fields: { label: string; text: string }[] };
type Settings = { schema: CmsSchema; current: Current; owner: boolean };

class RequestFailed extends Error {
  constructor(readonly status: number, readonly explanation: string | null, readonly problems: CmsProblem[] = []) { super("CMS request failed"); }
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
const CMS_FIELD_TYPES: readonly CollectionFieldType[] = ["text", "longText", "richText", "url", "image", "select", "reference", "tags", "datetime", "slug", "gallery"];
const CMS_FIELD_LABELS: Readonly<Record<CollectionFieldType, string>> = {
  text: "短いテキスト", longText: "複数行テキスト", richText: "リッチテキスト", url: "URL", image: "画像", select: "選択肢",
  reference: "別コレクションの項目", tags: "タグ", datetime: "日時", slug: "スラッグ", gallery: "画像ギャラリー"
};
const CMS_CAPABILITIES: readonly [keyof CmsCollection["capabilities"], string][] = [
  ["create", "新規項目"], ["duplicate", "複製"], ["remove", "削除"], ["unpublish", "公開取り下げ"], ["schedule", "公開予約"],
  ["redirects", "旧URLからの転送"], ["reorder", "手動並べ替え"], ["bulk", "複数項目の一括操作"], ["retrySchedule", "失敗した予約の再試行"]
];
const CMS_CHANGE_LABELS = { add: "追加", rename: "名前変更", convert: "設定変更・型変換", remove: "削除" } as const;
const CMS_PROBLEM_LABELS: Readonly<Record<CmsProblem["code"], string>> = {
  conversion: "値の変換", binding: "結び付け", route: "ルート", reference: "参照", value: "値の検証"
};
const sameItem = (a: CmsReleasePin, b: CmsReleasePin) => a.collectionId === b.collectionId && a.itemId === b.itemId;
function cmsDefinitionChanges(before: CmsSchema, after: CmsSchema): string[] {
  const changes: string[] = [];
  for (const collection of after.collections) {
    const old = before.collections.find(({ id }) => id === collection.id);
    if (!old) { changes.push(`コレクション追加: ${collection.label}`); continue; }
    if (old.label !== collection.label) changes.push(`${collection.label}: 表示名変更`);
    if (old.pathPrefix !== collection.pathPrefix) changes.push(`${collection.label}: 公開一覧パス変更`);
    if (old.ordering !== collection.ordering) changes.push(`${collection.label}: 一覧の並び順変更`);
    if (old.addLabel !== collection.addLabel) changes.push(`${collection.label}: 追加ボタン名変更`);
    const oldFields = new Set(old.fields.map(({ fieldId }) => fieldId));
    const nextFields = new Set(collection.fields.map(({ fieldId }) => fieldId));
    if (JSON.stringify(old.fields.map(({ fieldId }) => fieldId).filter((fieldId) => nextFields.has(fieldId)))
      !== JSON.stringify(collection.fields.map(({ fieldId }) => fieldId).filter((fieldId) => oldFields.has(fieldId)))) {
      changes.push(`${collection.label}: フィールドの並び替え`);
    }
    if (old.titleField !== collection.titleField || old.slugField !== collection.slugField || old.imageField !== collection.imageField
      || old.subtitleField !== collection.subtitleField || JSON.stringify(old.capabilities) !== JSON.stringify(collection.capabilities)) {
      changes.push(`${collection.label}: コレクション設定変更`);
    }
  }
  for (const collection of before.collections) if (!after.collections.some(({ id }) => id === collection.id)) changes.push(`コレクション削除: ${collection.label}`);
  return changes;
}

export function ManagedCmsWorkspace({ projectId, siteId, origin }: ManagedCmsWorkspaceProps) {
  const base = `/api/projects/${projectId}/sites/${siteId}/cms/v2`;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [collectionId, setCollectionId] = useState("");
  const [deleted, setDeleted] = useState(false);
  const [list, setList] = useState<List>({ items: [], nextCursor: null });
  const [item, setItem] = useState<CmsItemRevision | null>(null);
  const [itemStatus, setItemStatus] = useState<ItemSummary | null>(null);
  const [values, setValues] = useState<CollectionValues>({});
  const [jsonInvalidFields, setJsonInvalidFields] = useState<Record<string, boolean>>({});
  const [jsonEditorEpoch, setJsonEditorEpoch] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [showTranslation, setShowTranslation] = useState(false);
  const [at, setAt] = useState("");
  const [newCollection, setNewCollection] = useState({ label: "", slug: "" });
  const [schemaDraft, setSchemaDraft] = useState<CmsSchema | null>(null);
  const [schemaCollectionId, setSchemaCollectionId] = useState("");
  const [schemaPlan, setSchemaPlan] = useState<SchemaPlan | null>(null);
  const [schemaProblems, setSchemaProblems] = useState<CmsProblem[]>([]);
  const [schemaReplacements, setSchemaReplacements] = useState<Record<string, string>>({});
  const [schemaReplacementProblems, setSchemaReplacementProblems] = useState<Record<string, CmsProblem>>({});
  const [confirmSchemaImpact, setConfirmSchemaImpact] = useState(false);
  const [busy, setBusy] = useState(false);
  const pendingKeys = useRef(new Map<string, string>());
  const pendingPlans = useRef(new Map<string, Confirmation>());
  const [feedback, setFeedback] = useState("");
  const currentCollection = settings?.schema.collections.find(({ id }) => id === collectionId);
  const jsonInvalid = Object.values(jsonInvalidFields).some(Boolean);
  const dirty = item !== null && (JSON.stringify(item.values) !== JSON.stringify(values) || jsonInvalid);
  const editableSchema = schemaDraft ?? settings?.schema ?? null;
  const editableCollection = editableSchema?.collections.find(({ id }) => id === schemaCollectionId)
    ?? editableSchema?.collections.find(({ id }) => id === collectionId) ?? editableSchema?.collections[0];
  const schemaPlanDiff = settings && schemaPlan ? cmsDefinitionChanges(settings.schema, schemaPlan.candidate.schema) : [];
  const schemaPlanHasChanges = schemaPlanDiff.length > 0 || Boolean(schemaPlan?.candidate.changes.length);

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
    if (!response.ok) throw new RequestFailed(response.status, result?.problems?.[0]?.message ?? null, Array.isArray(result?.problems) ? result.problems : []);
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
    setShowTranslation(false);
    setItem(next); setItemStatus(summary); setValues(next?.values ?? {}); setJsonInvalidFields({});
    setJsonEditorEpoch((epoch) => epoch + 1); setPreview(null); setAt("");
  }
  function confirmDiscardChanges(): boolean {
    if (!dirty) return true;
    if (!window.confirm("保存していない変更を破棄して切り替えますか？")) return false;
    setValues(item!.values);
    setJsonInvalidFields({}); setJsonEditorEpoch((epoch) => epoch + 1);
    return true;
  }
  async function readItem(id: string) {
    return call<ItemRead>("cms.items.read", { collectionId, itemId: id });
  }
  async function refresh() {
    if (!confirmDiscardChanges()) return;
    const next = await loadSettings();
    const id = next.schema.collections.some(({ id }) => id === collectionId) ? collectionId : next.schema.collections[0]?.id ?? "";
    if (id !== collectionId) { showItem(null); setCollectionId(id); }
    await loadList(id, deleted);
    if (item && id === collectionId) {
      const selected = await readItem(item.itemId);
      showItem(selected.item, selected.summary);
    }
  }
  async function create() {
    if (!confirmDiscardChanges()) return;
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
        if (!snapshot || !cmsDraftMatchesPublishedValues(snapshot.schema, collectionId, latest.values, values)) {
          throw new RequestFailed(409, "定義の更新前に公開した内容があります。現在の定義で公開する項目を確認してください。");
        }
        return { revision: latest.revision, itemId, collectionId };
      }));
      if (!withdraw) pins.push({ itemId: draft.itemId, collectionId, revision: draft.revision });
      const oldPath = snapshot?.items.find((pin) => sameItem(pin, draft))?.path;
      const path = collectionPathForEditor(currentCollection!, draft.values);
      const redirects = redirectsForCmsRelease(snapshot?.redirects ?? [], oldPath ?? null, path, withdraw);
      const input = { locale: now.locale, schemaRevision: draft.schemaRevision, routeTableRevision: now.routeTableRevision,
        expectedReleaseId: snapshot?.releaseId ?? null, items: pins, redirects,
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
    if (!confirmDiscardChanges()) return;
    const { schema, current } = settings!;
    await call(restore ? "cms.items.restore" : "cms.items.remove",
      { collectionId, itemId: summary.id, expectedRevision: summary.revision, locale: current.locale,
        contractVersion: 2, expectedSchemaRevision: schema.schemaRevision }, true);
    showItem(null);
    await loadList(collectionId, deleted);
    setFeedback(restore ? "下書きへ復元しました。" : "ごみ箱へ移しました。");
  }
  function updateSchemaDraft(update: (schema: CmsSchema) => CmsSchema) {
    if (!settings) return;
    const next = update(schemaDraft ?? settings.schema);
    setSchemaDraft(next);
    setSchemaPlan(null); setSchemaProblems([]); setConfirmSchemaImpact(false);
  }
  function startSchemaEditing() {
    if (!settings) return;
    setSchemaDraft(settings.schema); setSchemaCollectionId(collectionId || settings.schema.collections[0]?.id || "");
    setSchemaPlan(null); setSchemaProblems([]); setSchemaReplacements({}); setSchemaReplacementProblems({}); setConfirmSchemaImpact(false);
  }
  function prepareNewCollection() {
    if (!settings || !newCollection.label.trim() || !/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(newCollection.slug)) return;
    const definition = starterCollection(newCollection.slug, newCollection.label, `/cms/${newCollection.slug}/`);
    updateSchemaDraft((schema) => ({ ...schema, collections: [...schema.collections, definition] }));
    setSchemaCollectionId(definition.id);
    setNewCollection({ label: "", slug: "" });
  }
  function schemaReplacementInput(schema: CmsSchema) {
    const groups = new Map<string, { collectionId: string; itemId: string; locale: string; values: Record<string, unknown> }>();
    for (const [replacementKey, problem] of Object.entries(schemaReplacementProblems)) {
      if ((problem.code !== "conversion" && problem.code !== "value") || !problem.collectionId || !problem.itemId || !problem.locale || !problem.fieldId) continue;
      const key = `${problem.locale}/${problem.collectionId}/${problem.itemId}`;
      const raw = schemaReplacements[replacementKey];
      if (raw === undefined) continue;
      const field = schema.collections.find(({ id }) => id === problem.collectionId)?.fields.find(({ fieldId }) => fieldId === problem.fieldId);
      if (!field) continue;
      let value: unknown = raw;
      if (["image", "gallery", "select", "reference", "tags"].includes(field.type)) {
        try { value = JSON.parse(raw); }
        catch { throw new RequestFailed(400, `${field.label}: 画像・選択肢・参照・タグの値は有効なJSONで入力してください。`); }
      }
      const group = groups.get(key) ?? { collectionId: problem.collectionId, itemId: problem.itemId, locale: problem.locale, values: {} };
      group.values[problem.fieldId] = value; groups.set(key, group);
    }
    return [...groups.values()];
  }
  async function planSchema() {
    if (!settings || !confirmDiscardChanges()) return;
    const candidate = schemaDraft ?? settings.schema;
    setSchemaPlan(null); setSchemaProblems([]); setConfirmSchemaImpact(false);
    try {
      const result = await call<{ plan: SchemaPlan }>("cms.schema.plan", {
        expectedSchemaRevision: settings.schema.schemaRevision,
        routeTableVersions: [{ locale: settings.current.locale, revision: settings.current.routeTableRevision }],
        nextSchema: candidate, replacements: schemaReplacementInput(candidate)
      });
      setSchemaPlan(result.plan); setSchemaProblems([]);
    } catch (error) {
      if (error instanceof RequestFailed && error.problems.length) {
        setSchemaProblems(error.problems);
        setSchemaReplacementProblems((previous) => {
          const next = { ...previous };
          for (const problem of error.problems) {
            if (!problem.collectionId || !problem.itemId || !problem.locale || !problem.fieldId) continue;
            next[`${problem.locale}/${problem.collectionId}/${problem.itemId}/${problem.fieldId}`] = problem;
          }
          return next;
        });
        return;
      }
      throw error;
    }
  }
  async function applySchema() {
    if (!settings || !schemaPlan || !confirmDiscardChanges()) return;
    const needsImpactConfirmation = schemaPlan.candidate.changes.some(({ kind }) => kind === "remove" || kind === "convert");
    if (needsImpactConfirmation && !confirmSchemaImpact) return;
    await call("cms.schema.apply", { operationId: schemaPlan.operationId, confirmationToken: schemaPlan.confirmationToken }, true);
    const next = await loadSettings();
    const selected = next.schema.collections.some(({ id }) => id === schemaCollectionId) ? schemaCollectionId : next.schema.collections[0]?.id ?? "";
    showItem(null); setCollectionId(selected); await loadList(selected, false);
    setSchemaDraft(next.schema); setSchemaPlan(null); setSchemaProblems([]); setSchemaReplacements({}); setSchemaReplacementProblems({}); setConfirmSchemaImpact(false);
    setFeedback("定義を適用しました。");
  }
  function updateField(collectionIdValue: string, fieldId: string, update: (field: CmsCollection["fields"][number]) => CmsCollection["fields"][number]) {
    updateSchemaDraft((schema) => ({ ...schema, collections: schema.collections.map((collection) => collection.id !== collectionIdValue ? collection : {
      ...collection, fields: collection.fields.map((field) => field.fieldId === fieldId ? update(field) : field)
    }) }));
  }
  function removeField(collection: CmsCollection, fieldId: string) {
    const fields = collection.fields.filter((field) => field.fieldId !== fieldId);
    if (!fields.length) return;
    const titleField = collection.titleField === fieldId ? fields.find((field) => field.type === "text")?.fieldId ?? collection.titleField : collection.titleField;
    updateSchemaDraft((schema) => ({ ...schema, collections: schema.collections.map((entry) => entry.id !== collection.id ? entry : {
      ...entry, fields, titleField,
      ...(entry.slugField === fieldId ? { slugField: null, pathPrefix: null } : {}),
      ...(entry.imageField === fieldId ? { imageField: null } : {}),
      ...(entry.subtitleField === fieldId ? { subtitleField: null } : {})
    }) }));
  }
  function reorderField(collectionIdValue: string, fieldId: string, direction: -1 | 1) {
    updateSchemaDraft((schema) => ({ ...schema, collections: schema.collections.map((collection) => {
      if (collection.id !== collectionIdValue) return collection;
      const index = collection.fields.findIndex((field) => field.fieldId === fieldId), target = index + direction;
      if (index < 0 || target < 0 || target >= collection.fields.length) return collection;
      const fields = [...collection.fields]; [fields[index], fields[target]] = [fields[target]!, fields[index]!];
      return { ...collection, fields };
    }) }));
  }
  function addField(collection: CmsCollection) {
    const existing = new Set([
      ...collection.fields.map(({ fieldId }) => fieldId),
      ...(settings?.schema.retiredFields ?? []).filter(({ collectionId }) => collectionId === collection.id).map(({ fieldId }) => fieldId)
    ]);
    let index = collection.fields.length + 1, fieldId = `field_${index}`;
    while (existing.has(fieldId)) fieldId = `field_${++index}`;
    const field: CmsCollection["fields"][number] = { fieldId, key: fieldId, label: "新しい項目", type: "text", placement: "main" };
    updateSchemaDraft((schema) => ({ ...schema, collections: schema.collections.map((entry) => entry.id === collection.id ? { ...entry, fields: [...entry.fields, field] } : entry) }));
  }
  function changeFieldType(collection: CmsCollection, fieldId: string, type: string) {
    const existing = collection.fields.find((field) => field.fieldId === fieldId);
    if (!existing) return;
    const base = { fieldId, key: existing.key, label: existing.label, placement: existing.placement,
      ...(existing.required === undefined ? {} : { required: existing.required }), ...(existing.hint ? { hint: existing.hint } : {}) };
    const targetCollection = schemaDraft?.collections[0]?.id ?? settings?.schema.collections[0]?.id ?? collection.id;
    const next = type === "text" ? { ...base, type: "text" as const }
      : type === "longText" ? { ...base, type: "longText" as const, rows: 6 }
      : type === "richText" ? { ...base, type: "richText" as const }
      : type === "url" ? { ...base, type: "url" as const }
      : type === "image" ? { ...base, type: "image" as const }
      : type === "select" ? { ...base, type: "select" as const, multiple: false, options: [{ id: "option_1", label: "選択肢 1" }] }
      : type === "reference" ? { ...base, type: "reference" as const, multiple: false, collectionId: targetCollection }
      : type === "tags" ? { ...base, type: "tags" as const }
      : type === "datetime" ? { ...base, type: "datetime" as const }
      : type === "slug" ? { ...base, type: "slug" as const }
      : type === "gallery" ? { ...base, type: "gallery" as const, captionLabel: "説明" }
      : existing;
    updateField(collection.id, fieldId, () => next);
  }
  async function selectCollection(id: string, discardConfirmed = false) {
    if (!discardConfirmed && !confirmDiscardChanges()) return;
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
      {settings.owner && <details onToggle={(event) => { if (event.currentTarget.open && !schemaDraft) startSchemaEditing(); }}>
        <summary>コレクションとフィールドの定義</summary>
        {editableSchema && <div className="studio-native-cms-schema">
          <p>定義の変更は計画を確認してから適用します。フォーム定義はここでは編集しません。</p>
          <label>編集するコレクション <select disabled={busy} value={editableCollection?.id ?? ""} onChange={(event) => setSchemaCollectionId(event.target.value)}>
            {editableSchema.collections.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select></label>
          {editableCollection && <>
            <fieldset disabled={busy}>
              <legend>コレクション</legend>
              <label>表示名 <input value={editableCollection.label} maxLength={80} onChange={(event) => updateSchemaDraft((schema) => ({
                ...schema, collections: schema.collections.map((entry) => entry.id === editableCollection.id ? { ...entry, label: event.target.value } : entry)
              }))} /></label>
              <label>項目追加ボタン <input value={editableCollection.addLabel} maxLength={40} onChange={(event) => updateSchemaDraft((schema) => ({
                ...schema, collections: schema.collections.map((entry) => entry.id === editableCollection.id ? { ...entry, addLabel: event.target.value } : entry)
              }))} /></label>
              <label>公開一覧パス <input value={editableCollection.pathPrefix ?? ""} placeholder="/cms/posts/" onChange={(event) => updateSchemaDraft((schema) => ({
                ...schema, collections: schema.collections.map((entry) => entry.id === editableCollection.id ? { ...entry, pathPrefix: event.target.value || null } : entry)
              }))} /></label>
              <label>一覧の並び順 <select value={editableCollection.ordering} onChange={(event) => updateSchemaDraft((schema) => ({
                ...schema, collections: schema.collections.map((entry) => entry.id === editableCollection.id ? { ...entry, ordering: event.target.value as "publishedAt" | "manual" } : entry)
              }))}><option value="publishedAt">公開日時</option><option value="manual">手動</option></select></label>
              <fieldset aria-label="コレクションの操作">
                <legend>利用できる操作</legend>
                {CMS_CAPABILITIES.map(([capability, label]) => <label key={capability}>
                  <input type="checkbox" checked={editableCollection.capabilities[capability] ?? false} onChange={(event) => updateSchemaDraft((schema) => ({
                    ...schema, collections: schema.collections.map((entry) => entry.id === editableCollection.id ? {
                      ...entry, capabilities: { ...entry.capabilities, [capability]: event.target.checked }
                    } : entry)
                  }))} /> {label}
                </label>)}
              </fieldset>
              <label>タイトルに使うフィールド <select value={editableCollection.titleField} onChange={(event) => updateSchemaDraft((schema) => ({
                ...schema, collections: schema.collections.map((entry) => entry.id === editableCollection.id ? { ...entry, titleField: event.target.value } : entry)
              }))}>{editableCollection.fields.filter(({ type }) => type === "text").map(({ fieldId, label }) => <option key={fieldId} value={fieldId}>{label}</option>)}</select></label>
              <label>スラッグフィールド <select value={editableCollection.slugField ?? ""} onChange={(event) => updateSchemaDraft((schema) => ({
                ...schema, collections: schema.collections.map((entry) => entry.id === editableCollection.id ? { ...entry,
                  slugField: event.target.value || null, pathPrefix: event.target.value ? entry.pathPrefix : null } : entry)
              }))}><option value="">使わない</option>{editableCollection.fields.filter(({ type }) => type === "slug").map(({ fieldId, label }) => <option key={fieldId} value={fieldId}>{label}</option>)}</select></label>
              <label>画像フィールド <select value={editableCollection.imageField ?? ""} onChange={(event) => updateSchemaDraft((schema) => ({
                ...schema, collections: schema.collections.map((entry) => entry.id === editableCollection.id ? { ...entry, imageField: event.target.value || null } : entry)
              }))}><option value="">使わない</option>{editableCollection.fields.filter(({ type }) => type === "image").map(({ fieldId, label }) => <option key={fieldId} value={fieldId}>{label}</option>)}</select></label>
              <label>副題フィールド <select value={editableCollection.subtitleField ?? ""} onChange={(event) => updateSchemaDraft((schema) => ({
                ...schema, collections: schema.collections.map((entry) => entry.id === editableCollection.id ? { ...entry, subtitleField: event.target.value || null } : entry)
              }))}><option value="">使わない</option>{editableCollection.fields.map(({ fieldId, label }) => <option key={fieldId} value={fieldId}>{label}</option>)}</select></label>
            </fieldset>
            <h3>フィールド</h3>
            <ol aria-label="フィールド定義">
              {editableCollection.fields.map((field, index) => <li key={field.fieldId}>
                <fieldset disabled={busy}>
                  <legend>{field.label || field.key}</legend>
                  <label>名前（APIキー） <input value={field.key} maxLength={80} onChange={(event) => updateField(editableCollection.id, field.fieldId, (current) => ({ ...current, key: event.target.value }))} /></label>
                  <label>表示名 <input value={field.label} maxLength={80} onChange={(event) => updateField(editableCollection.id, field.fieldId, (current) => ({ ...current, label: event.target.value }))} /></label>
                  <label>型 <select value={field.type} onChange={(event) => changeFieldType(editableCollection, field.fieldId, event.target.value)}>
                    {CMS_FIELD_TYPES.map((type) => <option key={type} value={type}>{CMS_FIELD_LABELS[type]}</option>)}
                  </select></label>
                  <label>表示位置 <select value={field.placement} onChange={(event) => updateField(editableCollection.id, field.fieldId, (current) => ({ ...current, placement: event.target.value as "main" | "side" }))}>
                    <option value="main">本文</option><option value="side">サイド</option>
                  </select></label>
                  <label><input type="checkbox" checked={field.required ?? false} onChange={(event) => updateField(editableCollection.id, field.fieldId, (current) => ({ ...current, required: event.target.checked }))} /> 必須</label>
                  <label>補足 <input value={field.hint ?? ""} maxLength={600} onChange={(event) => updateField(editableCollection.id, field.fieldId, (current) => {
                    if (event.target.value) return { ...current, hint: event.target.value };
                    const { hint: _hint, ...rest } = current; return rest;
                  })} /></label>
                  <CmsSchemaFieldOptions field={field} collections={editableSchema.collections} disabled={busy}
                    update={(next) => updateField(editableCollection.id, field.fieldId, () => next)} />
                  <div className="studio-site-hub-actions">
                    <button type="button" disabled={busy || index === 0} onClick={() => reorderField(editableCollection.id, field.fieldId, -1)}>上へ</button>
                    <button type="button" disabled={busy || index === editableCollection.fields.length - 1} onClick={() => reorderField(editableCollection.id, field.fieldId, 1)}>下へ</button>
                    <button type="button" disabled={busy || editableCollection.fields.length === 1 || field.fieldId === editableCollection.titleField && !editableCollection.fields.some((candidate) => candidate.fieldId !== field.fieldId && candidate.type === "text")}
                      onClick={() => removeField(editableCollection, field.fieldId)}>削除</button>
                  </div>
                </fieldset>
              </li>)}
            </ol>
            <button type="button" disabled={busy || editableCollection.fields.length >= 100} onClick={() => addField(editableCollection)}>フィールドを追加</button>
          </>}
          <details>
            <summary>コレクションを追加</summary>
            <form onSubmit={(event) => { event.preventDefault(); prepareNewCollection(); }}>
              <label>コレクション名 <input value={newCollection.label} maxLength={80} required onChange={(event) => setNewCollection({ ...newCollection, label: event.target.value })} /></label>
              <label>URL に使う名前 <input value={newCollection.slug} pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={44} required onChange={(event) => setNewCollection({ ...newCollection, slug: event.target.value })} /></label>
              <button disabled={busy}>定義に追加</button>
            </form>
          </details>
          <div className="studio-site-hub-actions">
            <button type="button" disabled={busy} onClick={() => run(planSchema)}>計画を作成・更新</button>
            <button type="button" disabled={busy || !schemaPlan || !schemaPlanHasChanges || dirty || schemaPlan.candidate.changes.some(({ kind }) => kind === "remove" || kind === "convert") && !confirmSchemaImpact}
              onClick={() => run(applySchema)}>計画を適用</button>
            <button type="button" disabled={busy} onClick={() => { setSchemaDraft(settings.schema); setSchemaPlan(null); setSchemaProblems([]); setSchemaReplacements({}); setSchemaReplacementProblems({}); setConfirmSchemaImpact(false); }}>変更を取り消す</button>
          </div>
          {schemaProblems.length > 0 && <section aria-label="定義の計画エラー">
            <h3>計画を修正してください</h3>
            <ul>{schemaProblems.map((problem, index) => {
              const field = problem.collectionId && problem.fieldId
                ? editableSchema.collections.find(({ id }) => id === problem.collectionId)?.fields.find(({ fieldId }) => fieldId === problem.fieldId) : undefined;
              const replacementKey = `${problem.locale}/${problem.collectionId}/${problem.itemId}/${problem.fieldId}`;
              const jsonReplacement = field && ["image", "gallery", "select", "reference", "tags"].includes(field.type);
              return <li key={`${problem.code}/${problem.collectionId}/${problem.itemId}/${problem.fieldId}/${index}`}>
                <strong>{CMS_PROBLEM_LABELS[problem.code]}:</strong> {problem.message}
                {(problem.pageId || problem.collectionId || problem.itemId || field || problem.locale) && <small>
                  {[problem.pageId && `ページ ${problem.pageId}`, problem.collectionId && `コレクション ${problem.collectionId}`, problem.itemId && `項目 ${problem.itemId}`,
                    problem.fieldId && `フィールド ${field?.label ?? problem.fieldId}`, problem.locale && `locale ${problem.locale}`, problem.path && `path ${problem.path}`].filter(Boolean).join(" / ")}
                </small>}
                {(problem.code === "conversion" || problem.code === "value") && problem.collectionId && problem.itemId && problem.locale && problem.fieldId && <label>
                  設定する値 <textarea value={schemaReplacements[replacementKey] ?? ""}
                    placeholder={jsonReplacement ? "JSON 値を入力" : "値を入力"}
                    onChange={(event) => setSchemaReplacements((previous) => ({ ...previous, [replacementKey]: event.target.value }))} />
                </label>}
              </li>;
            })}</ul>
            <p>変換値を入力したら、もう一度「計画を作成・更新」を押してください。</p>
          </section>}
          {schemaPlan && <section aria-label="定義の移行計画">
            <h3>移行計画</h3>
            <p>{schemaPlan.candidate.items.length} 件の項目を移行し、削除済みコレクションの {schemaPlan.candidate.removedItems.length} 件を確認しました。</p>
            <h4>定義の差分</h4>
            {schemaPlanDiff.length ? <ul>{schemaPlanDiff.map((change, index) => <li key={`${change}/${index}`}>{change}</li>)}</ul> : <p>コレクション設定に差分はありません。</p>}
            <h4>フィールドの移行</h4>
            <ul>{schemaPlan.candidate.changes.map((change, index) => {
              const field = settings.schema.collections.find(({ id }) => id === change.collectionId)?.fields.find(({ fieldId }) => fieldId === change.fieldId)
                ?? schemaPlan.candidate.schema.collections.find(({ id }) => id === change.collectionId)?.fields.find(({ fieldId }) => fieldId === change.fieldId);
              return <li key={`${change.collectionId}/${change.fieldId}/${index}`}>{change.collectionId} / {field?.label ?? change.fieldId}: {CMS_CHANGE_LABELS[change.kind]}</li>;
            })}</ul>
            {schemaPlan.candidate.changes.some(({ kind }) => kind === "remove" || kind === "convert") && <label>
              <input type="checkbox" checked={confirmSchemaImpact} onChange={(event) => setConfirmSchemaImpact(event.target.checked)} />
              削除または型変換を含む計画を確認し、値への影響を理解しました
            </label>}
          </section>}
        </div>}
      </details>}
      {currentCollection && <div className="studio-native-cms-columns">
        <div>
          <div className="studio-site-hub-actions">
            <button disabled={busy} aria-pressed={deleted} onClick={() => run(async () => {
              if (!confirmDiscardChanges()) return;
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
                    if (!confirmDiscardChanges()) return;
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
          {showTranslation ? <>
            <button type="button" disabled={busy} onClick={() => setShowTranslation(false)}>日本語 CMS に戻る</button>
            <Suspense fallback={<p>翻訳を読み込んでいます…</p>}>
              <ManagedCmsTranslation projectId={projectId} siteId={siteId}
                itemKey={cmsLocalizationItemKey(collectionId, item.itemId)}
                onBack={() => setShowTranslation(false)} registerBack={() => {}} />
            </Suspense>
          </> : <>
          <div className="studio-site-hub-actions">
            {(item.locale === "ja" || item.locale === "en") && <button type="button" disabled={busy || dirty} onClick={() => setShowTranslation(true)}>
              {item.locale === "ja" ? "English の訳文" : "日本語の訳文"}
            </button>}
          </div>
          <form onSubmit={(event) => { event.preventDefault(); run(save); }}>
            {currentCollection.fields.map((field) => <CmsFieldEditor key={`${collectionId}/${item.itemId}/${item.revision}/${field.fieldId}/${jsonEditorEpoch}`} field={field} value={values[field.fieldId] ?? null}
              invalidChange={(invalid) => setJsonInvalidFields((previous) => {
                if (previous[field.fieldId] === invalid) return previous;
                const next = { ...previous };
                if (invalid) next[field.fieldId] = true; else delete next[field.fieldId];
                return next;
              })}
              disabled={busy} update={(value) => setValues({ ...values, [field.fieldId]: value })} />)}
            <button disabled={busy || !dirty || jsonInvalid}>下書きを保存</button>
          </form>
          <div className="studio-site-hub-actions">
            <button disabled={busy || dirty} onClick={() => run(async () => {
              const { previewId } = await call<{ previewId: string }>("cms.preview.prepare",
                { collectionId, itemId: item.itemId, revision: item.revision });
              setPreview((await call<{ preview: Preview }>("cms.preview.read", { previewId })).preview);
            })}>下書きをプレビュー</button>
            <button disabled={busy || dirty} onClick={() => run(() => release(false))}>公開する</button>
            {settings.current.snapshot?.items.some((pin) => sameItem(pin, item)) &&
              <button disabled={busy || dirty} onClick={() => run(() => release(true))}>公開を取り下げる</button>}
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
              if (!confirmDiscardChanges()) return;
              await call("cms.schedule.cancel", { scheduleId: itemStatus.scheduleId }, true);
              await refresh();
              setFeedback("予約を取り消しました。");
            })}>予約を取り消す</button>}
            {itemStatus.status === "draft" && !itemStatus.scheduleId && currentCollection.capabilities.remove &&
              <button disabled={busy || dirty} onClick={() => run(() => remove(itemStatus, false))}>ごみ箱へ移す</button>}
          </div>}
          </>}
        </div>}
      </div>}
    </>}
  </section>;
}

function CmsSchemaFieldOptions({ field, collections, disabled, update }: {
  field: CmsCollection["fields"][number]; collections: readonly CmsCollection[]; disabled: boolean;
  update: (field: CmsCollection["fields"][number]) => void;
}) {
  if (field.type === "text" || field.type === "url") return <>
    <label>入力例 <input disabled={disabled} value={field.placeholder ?? ""} onChange={(event) => {
      if (event.target.value) update({ ...field, placeholder: event.target.value });
      else { const { placeholder: _placeholder, ...rest } = field; update(rest); }
    }} /></label>
    {field.type === "text" && <label>最大文字数 <input type="number" min="1" max="1000000" disabled={disabled} value={field.maxLength ?? ""}
      onChange={(event) => {
        if (event.target.value) update({ ...field, maxLength: Number(event.target.value) });
        else { const { maxLength: _maxLength, ...rest } = field; update(rest); }
      }} /></label>}
  </>;
  if (field.type === "longText") return <>
    <label>表示する行数 <input type="number" min="1" max="40" disabled={disabled} value={field.rows}
      onChange={(event) => update({ ...field, rows: event.target.value ? Number(event.target.value) : 1 })} /></label>
    <label>最大文字数 <input type="number" min="1" max="1000000" disabled={disabled} value={field.maxLength ?? ""}
      onChange={(event) => {
        if (event.target.value) update({ ...field, maxLength: Number(event.target.value) });
        else { const { maxLength: _maxLength, ...rest } = field; update(rest); }
      }} /></label>
  </>;
  if (field.type === "image") return <label>画像の形 <select disabled={disabled} value={field.shape ?? "rect"} onChange={(event) => update({ ...field, shape: event.target.value as "rect" | "round" })}>
    <option value="rect">四角</option><option value="round">丸</option>
  </select></label>;
  if (field.type === "select") return <>
    <label><input type="checkbox" disabled={disabled} checked={field.multiple} onChange={(event) => update({ ...field, multiple: event.target.checked })} /> 複数選択</label>
    <div aria-label="選択肢">
      {field.options.map((option, index) => <div key={`${field.fieldId}/${index}`}>
        <label>選択肢ID <input disabled={disabled} value={option.id} onChange={(event) => update({ ...field, options: field.options.map((entry, i) => i === index ? { ...entry, id: event.target.value } : entry) })} /></label>
        <label>選択肢名 <input disabled={disabled} value={option.label} onChange={(event) => update({ ...field, options: field.options.map((entry, i) => i === index ? { ...entry, label: event.target.value } : entry) })} /></label>
        <button type="button" disabled={disabled || field.options.length < 2} onClick={() => update({ ...field, options: field.options.filter((_, i) => i !== index) })}>選択肢を削除</button>
      </div>)}
    </div>
    <button type="button" disabled={disabled || field.options.length >= 200} onClick={() => update({ ...field, options: [...field.options, { id: `option_${field.options.length + 1}`, label: `選択肢 ${field.options.length + 1}` }] })}>選択肢を追加</button>
  </>;
  if (field.type === "reference") return <>
    <label>参照先 <select disabled={disabled} value={field.collectionId} onChange={(event) => update({ ...field, collectionId: event.target.value })}>
      {collections.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
    </select></label>
    <label><input type="checkbox" disabled={disabled} checked={field.multiple} onChange={(event) => update({ ...field, multiple: event.target.checked })} /> 複数選択</label>
  </>;
  if (field.type === "gallery") return <label>説明欄の名前 <input disabled={disabled} value={field.captionLabel} maxLength={80} onChange={(event) => update({ ...field, captionLabel: event.target.value })} /></label>;
  return null;
}

function CmsFieldEditor({ field, value, disabled, update, invalidChange }: {
  field: CmsCollection["fields"][number]; value: CollectionValue; disabled: boolean; update: (value: CollectionValue) => void;
  invalidChange: (invalid: boolean) => void;
}) {
  const text = typeof value === "string" ? value : "";
  if (field.type === "longText" || field.type === "richText") return <label>{field.label}
    <textarea disabled={disabled} value={text} rows={field.type === "longText" ? field.rows : 6} onChange={(event) => update(event.target.value)} />
  </label>;
  if (["text", "slug", "url", "datetime"].includes(field.type)) return <label>{field.label}
    <input disabled={disabled} value={text} onChange={(event) => update(field.type === "datetime" && !event.target.value ? null : event.target.value)} />
  </label>;
  return <JsonFieldEditor label={field.label} value={value} disabled={disabled} update={update} invalidChange={invalidChange} />;
}

function JsonFieldEditor({ label, value, disabled, update, invalidChange }: {
  label: string; value: CollectionValue; disabled: boolean; update: (value: CollectionValue) => void; invalidChange: (invalid: boolean) => void;
}) {
  const [text, setText] = useState(JSON.stringify(value));
  return <label>{label} <textarea disabled={disabled} value={text} onChange={(event) => {
    const next = event.target.value;
    setText(next);
    try {
      update(JSON.parse(next) as CollectionValue);
      invalidChange(false);
      event.target.setCustomValidity("");
    } catch {
      invalidChange(true);
      event.target.setCustomValidity("有効な JSON を入力してください。");
    }
  }} /></label>;
}
