import { useEffect, useState } from "react";
import { cmsBindingAttributes, cmsPageBindingProblems, cmsPageFieldMatches, parseCmsPageBindings, type CmsPageBindingsDocument, type CmsPageFieldBinding, type CmsPageListBinding } from "./cms-page-bindings.js";
import type { CmsCollection } from "./cms-v2-schema.js";
import { walkNodes } from "./node-tree.js";
import type { EditorCmsBindingsAdapter, EditorTarget } from "./editor-types.js";
import type { PageDocument } from "./types.js";

const mappingLabels: Record<CmsPageFieldBinding["target"], string> = {
  text: "テキスト", "rich-text": "本文（書式付き）", image: "画像", link: "リンク", "detail-link": "詳細ページへのリンク", attribute: "属性"
};
type Catalog = Awaited<ReturnType<EditorCmsBindingsAdapter["read"]>>;
type Props = {
  adapter: EditorCmsBindingsAdapter; target: EditorTarget; document: PageDocument; version: string;
  saved: CmsPageBindingsDocument | null; selectedNode?: string; disabled: boolean; path?: string;
  insertTemplate(): { root: string; title: string } | undefined;
  apply(bindings: CmsPageBindingsDocument | null): void;
  show(document: PageDocument): void;
};

export function CmsBindingsPanel(props: Props) {
  const [opened, setOpened] = useState(false);
  return <details className="e-inspector-content" onToggle={(event) => { if (event.currentTarget.open) setOpened(true); }}>
    <summary>CMS の結び付け</summary>
    {opened && <BindingForm {...props} />}
  </details>;
}

function BindingForm({ adapter, target, document, version, saved, selectedNode, disabled, path, insertTemplate, apply, show }: Props) {
  const [catalog, setCatalog] = useState<Catalog>(), [working, setWorking] = useState<CmsPageBindingsDocument>(() => saved ?? { schemaVersion: 1, ...target, lists: [] });
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [itemKey, setItemKey] = useState("");
  const [retry, setRetry] = useState(0);
  const [previewRequest, setPreviewRequest] = useState<AbortController>();
  useEffect(() => () => previewRequest?.abort(), [previewRequest]);
  useEffect(() => { setWorking(saved ?? { schemaVersion: 1, ...target, lists: [] }); }, [saved, target]);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void adapter.read(target, controller.signal).then((result) => {
      if (!controller.signal.aborted) setCatalog(result);
    }, () => { if (!controller.signal.aborted) setError("CMS を読み込めませんでした。"); });
    return () => controller.abort();
  }, [adapter, target, retry]);
  if (!catalog) return error ? <><p role="alert">{error}</p><button type="button" onClick={() => setRetry(retry + 1)}>再読込</button></> : <p role="status">CMS を読み込んでいます。</p>;
  const { schema } = catalog, collections = schema.collections, listCollection = collections[0];
  const entries = walkNodes(document);
  const items = catalog.items.filter((item) => working.detail ? item.collectionId === working.detail.collectionId : working.lists.some(({ collectionId }) => collectionId === item.collectionId));
  const selectedItem = items.find((item) => item.collectionId + "/" + item.itemId === itemKey);
  const capableDetailCollections = collections.filter((collection) => collection.slugField !== null);
  const detailCollection = capableDetailCollections.find(({ id }) => id === working.detail?.collectionId);
  const withDetail = (collection: CmsCollection) => setWorking({ ...working, detail: { collectionId: collection.id, slugFieldId: collection.slugField!, ...(working.detail?.basePath === undefined ? {} : { basePath: working.detail.basePath }), fields: [] } });
  const listTargets = (rootId: string) => {
    const root = entries.find(({ node }) => node.type === "element" && node.id === rootId);
    return root ? entries.filter(({ path }) => root.path.every((index, depth) => path[depth] === index)) : [];
  };
  const elementOptions = (nodes: ReturnType<typeof walkNodes>) => nodes.flatMap(({ node }) => node.type === "element"
    ? [{ id: node.id, label: node.name ?? node.tag + " · " + node.id }] : []);
  const templates = elementOptions(entries.filter(({ node }) => node.type === "element" && ["div", "article", "section", "li"].includes(node.tag)));
  const repeated = new Set(working.lists.flatMap(({ templateNodeId }) => listTargets(templateNodeId)));
  function replaceList(index: number, updated: CmsPageListBinding) {
    setWorking({ ...working, lists: working.lists.map((entry, offset) => index === offset ? updated : entry) });
  }
  function insertList() {
    if (!listCollection) return;
    const template = insertTemplate();
    if (!template) return;
    const candidate: CmsPageBindingsDocument = { ...working, lists: [...working.lists, { templateNodeId: template.root, collectionId: listCollection.id, limit: 6,
      fields: [{ nodeId: template.title, fieldId: listCollection.titleField, target: "text" }] }] };
    setWorking(candidate);
    if (saved ? JSON.stringify(saved) === JSON.stringify(working) : !working.lists.length && !working.detail) apply(candidate);
  }
  function checkedBindings() {
    const bindings = parseCmsPageBindings(working, target), problems = cmsPageBindingProblems(document, bindings, schema);
    if (problems[0]) throw new Error(problems[0].message);
    return bindings;
  }
  function applyBindings() {
    setError("");
    try {
      const bindings = checkedBindings();
      apply(bindings.lists.length || bindings.detail ? bindings : null);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "CMS の結び付けを確認してください。"); }
  }
  async function preview() {
    if (!selectedItem) return;
    setError("");
    const controller = new AbortController();
    setPreviewRequest(controller);
    try {
      const cmsBindings = checkedBindings();
      setBusy(true);
      const projected = await adapter.preview({ target, expectedVersion: version, document, cmsBindings, item: selectedItem }, controller.signal);
      if (!controller.signal.aborted) show(projected);
    } catch { if (!controller.signal.aborted) setError("CMS の実データをプレビューできませんでした。結び付けと項目を確認してください。"); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <fieldset disabled={disabled || busy} style={{ margin: 0, padding: 0, border: 0 }}>
    <button type="button" onClick={insertList} disabled={!listCollection || working.lists.length >= 12}>CMS リストを挿入</button>
    {working.lists.map((list, index) => {
      const collection = collections.find(({ id }) => id === list.collectionId);
      const sortFields = collection?.fields.filter(({ type }) => ["text", "longText", "datetime", "slug"].includes(type)) ?? [];
      const filterFields = collection?.fields.filter((field) => sortFields.includes(field) || field.type === "select" || field.type === "reference") ?? [];
      const filterField = filterFields.find(({ fieldId }) => fieldId === list.filter?.fieldId);
      return <details key={list.templateNodeId} open>
        <summary>CMS リスト {index + 1}</summary>
        <label className="e-field"><span>コレクション</span><select value={list.collectionId} onChange={(event) => replaceList(index, { templateNodeId: list.templateNodeId, collectionId: event.target.value, limit: list.limit, fields: [] })}>
          {!collection && <option value={list.collectionId}>{list.collectionId}</option>}{collections.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        </select></label>
        <label className="e-field"><span>繰り返す要素</span><select value={list.templateNodeId} onChange={(event) => replaceList(index, { ...list, templateNodeId: event.target.value, fields: [] })}>
          {!templates.some(({ id }) => id === list.templateNodeId) && <option value={list.templateNodeId}>{list.templateNodeId}（要素なし）</option>}
          {templates.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        </select></label>
        <label className="e-field"><span>表示件数</span><input type="number" min={1} max={25} value={list.limit || ""} onChange={(event) => replaceList(index, { ...list, limit: Number(event.target.value) })} /></label>
        <label className="e-field"><span>絞り込むフィールド</span><select value={list.filter?.fieldId ?? ""} onChange={(event) => {
          const { filter: _filter, ...without } = list;
          replaceList(index, event.target.value ? { ...without, filter: { fieldId: event.target.value, ...(["reference"].includes(collection?.fields.find(({ fieldId }) => fieldId === event.target.value)?.type ?? "") || collection?.fields.some((field) => field.fieldId === event.target.value && field.type === "select" && field.multiple) ? { includes: "" } : { equals: "" }) } } : without);
        }}><option value="">絞り込みなし</option>{filterFields.map(({ fieldId, label }) => <option key={fieldId} value={fieldId}>{label}</option>)}</select></label>
        {list.filter && <label className="e-field"><span>{"includes" in list.filter ? "含む値" : "一致する値"}</span>{filterField?.type === "select"
          ? <select value={"includes" in list.filter ? list.filter.includes : list.filter.equals} onChange={(event) => replaceList(index, { ...list, filter: "includes" in list.filter! ? { fieldId: list.filter!.fieldId, includes: event.target.value } : { fieldId: list.filter!.fieldId, equals: event.target.value } })}><option value="">選択</option>{filterField.options.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}</select>
          : <input value={"includes" in list.filter ? list.filter.includes : list.filter.equals} onChange={(event) => replaceList(index, { ...list, filter: "includes" in list.filter! ? { fieldId: list.filter!.fieldId, includes: event.target.value } : { fieldId: list.filter!.fieldId, equals: event.target.value } })} />}</label>}
        <label className="e-field"><span>並べ替えるフィールド</span><select value={list.order?.fieldId ?? ""} onChange={(event) => {
          const { order: _order, ...without } = list;
          replaceList(index, event.target.value ? { ...without, order: { fieldId: event.target.value, direction: "desc" } } : without);
        }}><option value="">CMS 公開版の順序</option>{sortFields.map(({ fieldId, label }) => <option key={fieldId} value={fieldId}>{label}</option>)}</select></label>
        {list.order && <label className="e-field"><span>並び順</span><select value={list.order.direction} onChange={(event) => replaceList(index, { ...list, order: { fieldId: list.order!.fieldId, direction: event.target.value === "asc" ? "asc" : "desc" } })}><option value="desc">降順</option><option value="asc">昇順</option></select></label>}
        {collection && <FieldMappings collection={collection} nodes={elementOptions(listTargets(list.templateNodeId))} selectedNode={selectedNode}
          value={list.fields} change={(fields) => replaceList(index, { ...list, fields })} />}
        <button type="button" onClick={() => setWorking({ ...working, lists: working.lists.filter((_, offset) => offset !== index) })}>リストの結び付けを解除</button>
      </details>;
    })}
    {!working.detail && capableDetailCollections[0] && path && path !== "/" && <button type="button" onClick={() => withDetail(capableDetailCollections[0]!)}>CMS 詳細ページにする</button>}
    {working.detail && <details open>
      <summary>CMS 詳細ページ</summary>
      {path && <p className="e-help">公開 URL は {working.detail.basePath ?? path}/スラッグ です。</p>}
      <label className="e-field"><span>コレクション</span><select value={working.detail.collectionId} onChange={(event) => {
        const next = capableDetailCollections.find(({ id }) => id === event.target.value);
        if (next) withDetail(next);
      }}>{!detailCollection && <option value={working.detail.collectionId}>{working.detail.collectionId}</option>}{capableDetailCollections.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}</select></label>
      {detailCollection && <FieldMappings collection={detailCollection} nodes={elementOptions(entries.filter((entry) => !repeated.has(entry)))} selectedNode={selectedNode}
        value={working.detail.fields} change={(fields) => setWorking({ ...working, detail: { ...working.detail!, fields } })} />}
      <button type="button" onClick={() => { const { detail: _detail, ...without } = working; setWorking(without); }}>詳細ページの結び付けを解除</button>
    </details>}
    {items.length > 0 && <><label className="e-field"><span>プレビューする CMS 項目</span><select value={itemKey} onChange={(event) => setItemKey(event.target.value)}><option value="">項目を選択</option>
      {items.map((item) => <option key={item.collectionId + "/" + item.itemId} value={item.collectionId + "/" + item.itemId}>{item.label}</option>)}</select></label>
      <button type="button" disabled={!selectedItem} onClick={() => void preview()}>実データでプレビュー</button></>}
    {(saved !== null || working.lists.length > 0 || working.detail) && <button type="button" onClick={applyBindings}>結び付けを適用</button>}
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}

function FieldMappings({ collection, nodes, selectedNode, value, change }: {
  collection: CmsCollection; nodes: readonly { id: string; label: string }[]; selectedNode: string | undefined;
  value: readonly CmsPageFieldBinding[]; change(value: readonly CmsPageFieldBinding[]): void;
}) {
  const replace = (index: number, entry: CmsPageFieldBinding) => change(value.map((current, i) => i === index ? entry : current));
  return <div>
    {value.map((entry, index) => {
      const fields = collection.fields.filter((field) => cmsPageFieldMatches(field, entry));
      return <fieldset key={index}>
        <legend>値の結び付け {index + 1}</legend>
        <label className="e-field"><span>要素</span><select value={entry.nodeId} onChange={(event) => replace(index, { ...entry, nodeId: event.target.value })}>
          {!nodes.some(({ id }) => id === entry.nodeId) && <option value={entry.nodeId}>{entry.nodeId}（要素なし）</option>}
          {nodes.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label className="e-field"><span>値の種類</span><select value={entry.target} onChange={(event) => {
          const target = event.target.value as CmsPageFieldBinding["target"];
          const base = { nodeId: entry.nodeId, fieldId: entry.fieldId };
          const next: CmsPageFieldBinding = target === "attribute" ? { ...base, target, attribute: "title" } : target === "detail-link" ? { ...base, target, path: "" } : { ...base, target };
          replace(index, { ...next, fieldId: collection.fields.find((field) => cmsPageFieldMatches(field, next))?.fieldId ?? "" });
        }}>{Object.entries(mappingLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        {entry.target === "attribute" && <label className="e-field"><span>属性</span><select value={entry.attribute} onChange={(event) => {
          const next = { ...entry, attribute: event.target.value as typeof entry.attribute };
          replace(index, { ...next, fieldId: collection.fields.find((field) => cmsPageFieldMatches(field, next))?.fieldId ?? "" });
        }}>{cmsBindingAttributes.map((attribute) => <option key={attribute}>{attribute}</option>)}</select></label>}
        {entry.target === "detail-link" && <label className="e-field"><span>詳細ページのパス</span><input value={entry.path} placeholder="/articles" onChange={(event) => replace(index, { ...entry, path: event.target.value })} /></label>}
        <label className="e-field"><span>フィールド</span><select value={entry.fieldId} onChange={(event) => replace(index, { ...entry, fieldId: event.target.value })}>
          {!fields.some(({ fieldId }) => fieldId === entry.fieldId) && <option value={entry.fieldId}>フィールドを選択</option>}
          {fields.map(({ fieldId, label }) => <option key={fieldId} value={fieldId}>{label}</option>)}
        </select></label>
        <button type="button" onClick={() => change(value.filter((_, i) => i !== index))}>この結び付けを解除</button>
      </fieldset>;
    })}
    <button type="button" disabled={!nodes.length || value.length >= 80} onClick={() => {
      const node = nodes.find(({ id }) => id === selectedNode) ?? nodes[0];
      if (node) change([...value, { nodeId: node.id, fieldId: collection.titleField, target: "text" }]);
    }}>フィールドを結び付ける</button>
  </div>;
}
