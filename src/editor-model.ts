import { resolvePageStyles, retainPageStyles, type SiteStyles } from "./site-styles.js";
import { detachInstance } from "./component-model.js";
import { parsePageDocument, parsePageMeta, parsePageNodeName, validatePageDocument } from "./document.js";
import { cloneEditorValue, createCopyOnWrite, finishCopyOnWrite } from "./immutable-draft.js";
import type { EditorBlockRegistry, EditorLock, EditorPage, EditorPageChange, EditorPageChangePlan, EditorPageImpact, EditorReadOnly, EditorReleasePlan, EditorReleaseRequest, EditorSite, EditorTarget } from "./editor-types.js";
import { findPathConflict, validatePagePath } from "./pages.js";
import { indexedNodes, indexedNodesById, nodeAt, siblingsAt, walkNodes, type NodePath } from "./node-tree.js";
import { normalizeNodeFragment } from "./editor-fragment.js";
import type { Appear, AssetReference, BlockContract, ComponentLibrary, ComponentNode, DesignToken, ElementNode, HiddenRange, IconName, InstanceNode, NodeStyle, PageDocument, PageMeta, PageNode, PublicPropValue, StateName, StateProperty, StyleDeclarations, StyleProperty, StyleValue, TextStyle } from "./types.js";
import { parseStyle, parseTextStyles, parseTokens, stateNames, textStyleProperties } from "./style-values.js";
import { assertMotionStylePatch, sameMotionValue, type MotionStylePatch } from "./builder.js";
import { fail, identifier, isSafeHttpsOrigin, isSafePublicUrl, keys, line, record } from "./validation-utils.js";
import { normalizeEmbedSource } from "./embeds.js";

export { nodeAt, walkNodes, type NodePath };
export { normalizeNodeFragment } from "./editor-fragment.js";
export type NodePositionAnchor = { readonly before: string } | { readonly after: string } | { readonly edge: "start" | "end" };
export type PageOperationTextPathContextEntry =
  | { readonly type: "target" }
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "element" | "component" | "instance"; readonly nodeId: string };
export type PageOperationPreconditions = {
  readonly parentId: string | null;
  readonly oldValue: StyleValue | PublicPropValue | string | null;
  readonly textPathContext?: readonly PageOperationTextPathContextEntry[];
};
export const PAGE_OPERATION_TEXT_PATH_CONTEXT_MAX_CHILDREN = 8;
export const PAGE_OPERATION_TEXT_PATH_CONTEXT_MAX_SIBLING_TEXT_LENGTH = 128;
/** Describes the exact sibling order around a direct text child so stale childPath edits cannot target another text node. */
export function pageOperationTextPathContext(document: PageDocument, parentId: string | null, childPath: readonly number[]): PageOperationTextPathContextEntry[] | undefined {
  if (childPath.length !== 1) return undefined;
  let children: readonly PageNode[];
  if (parentId === null) children = document.body;
  else {
    const matches = walkNodes(document).filter(({ node }) => node.type !== "text" && node.id === parentId);
    if (matches.length !== 1 || matches[0]!.node.type !== "element") return undefined;
    children = matches[0]!.node.children;
  }
  const targetIndex = childPath[0]!;
  if (children.length > PAGE_OPERATION_TEXT_PATH_CONTEXT_MAX_CHILDREN || targetIndex >= children.length) return undefined;
  const context: PageOperationTextPathContextEntry[] = [];
  for (const [index, child] of children.entries()) {
    if (index === targetIndex && child.type === "text") context.push({ type: "target" });
    else if (child.type === "text") {
      if (child.text.length > PAGE_OPERATION_TEXT_PATH_CONTEXT_MAX_SIBLING_TEXT_LENGTH) return undefined;
      context.push({ type: "text", value: child.text });
    } else context.push({ type: child.type, nodeId: child.id });
  }
  return context;
}
export type EditorOperation =
  | { type: "text"; path: NodePath; value: string }
  | { type: "attribute"; path: NodePath; name: string; value: string }
  | { type: "booleanAttribute"; path: NodePath; name: "controls" | "loop" | "muted" | "playsInline" | "required" | "checked" | "disabled"; value: boolean }
  /** select / radio fieldset の表示値。空行を除いた1〜20件へ置き換える。 */
  | { type: "formChoices"; path: NodePath; values: readonly string[] }
  /** form の送信成功後にホストが解決するページ ID。undefined で解除する。 */
  | { type: "formCompletionPage"; path: NodePath; pageId: string | undefined }
  | { type: "icon"; path: NodePath; name: IconName }
  | { type: "tag"; path: NodePath; value: "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" }
  | { type: "prop"; path: NodePath; name: string; value: PublicPropValue | undefined }
  | { type: "style"; path: NodePath; breakpoint: number | "base"; property: StyleProperty; value: StyleValue | undefined }
  | { type: "resize"; path: NodePath; breakpoint: number | "base"; width: number; height: number; /** styleRange と同じく、この段だけを変えるときの次の段の開始幅。 */ until?: number }
  /** 複数プロパティを 1 履歴で変更する。undefined は削除。 */
  | { type: "styles"; path: NodePath; breakpoint: number | "base"; values: Partial<Record<StyleProperty, StyleValue | undefined>> }
  /** 段 breakpoint だけを変える。until（次の段の開始幅）以上で効いていた値を先に段 until へ書き、広い幅の見た目を保つ。 */
  | { type: "styleRange"; path: NodePath; breakpoint: number | "base"; until: number; values: Partial<Record<StyleProperty, StyleValue | undefined>> }
  /** 作成・更新。undefined は削除で、参照は現在の値の literal へ置き換える。 */
  | { type: "token"; name: string; token: DesignToken | undefined }
  /** 作成・更新。undefined は削除で、利用ノードへ宣言をコピーしてから参照を外す。 */
  | { type: "textStyle"; name: string; style: TextStyle | undefined }
  | { type: "nodeTextStyle"; path: NodePath; name: string | undefined; detach?: boolean }
  /** 状態スタイル。undefined は削除。also の状態にも同じ値を書く（ホバーとフォーカスをそろえる）。 */
  | { type: "state"; path: NodePath; state: StateName; values: Partial<Record<StateProperty, StyleValue | undefined>>; also?: readonly StateName[] }
  /** 登場の演出。undefined で解除。 */
  | { type: "appear"; path: NodePath; value: Appear | undefined }
  /** 動きに関係する宣言pathだけを1回の履歴で適用する。responsive・hidden・文字スタイルは保持する。 */
  | { type: "motionPreset"; path: NodePath; style: MotionStylePatch | undefined; /** 切替・解除するactive preset。宣言pathだけを外す。 */ previous?: MotionStylePatch }
  /** 幅別の非表示。undefined・空配列で解除。 */
  | { type: "hidden"; path: NodePath; ranges: readonly HiddenRange[] | undefined }
  | { type: "title"; value: string }
  | { type: "name"; path: NodePath; value: string | undefined }
  | { type: "add"; parentId: string | null; node: PageNode; index?: number; anchor?: NodePositionAnchor }
  | { type: "addMany"; parentId: string | null; nodes: readonly PageNode[]; index?: number; anchor?: NodePositionAnchor }
  | { type: "replaceChildren"; path: NodePath; children: PageNode[] }
  | { type: "image"; path: NodePath; source: { asset: AssetReference } | { src: string; srcset?: string }; alt?: string }
  | { type: "video"; path: NodePath; source: { asset: AssetReference } | { src: string } }
  /** provider は挿入時に固定。標準 provider は canonical URL、blank はホスト承認済み key へ更新する。 */
  | { type: "embedSource"; path: NodePath; source: string }
  | { type: "embedTitle"; path: NodePath; title: string }
  /** Loop Box の閉じた runtime 設定。方向は通常の flexDirection style で編集する。 */
  | { type: "loopBox"; path: NodePath; speed: number; pauseOnHover: boolean }
  | { type: "background"; path: NodePath; breakpoint: number | "base"; asset: AssetReference | undefined }
  | { type: "replaceAsset"; from: AssetReference; to: AssetReference }
  | { type: "duplicate" | "remove"; path: NodePath }
  | { type: "wrap"; nodeIds: readonly string[]; wrapperId: string; allowLayoutChange?: boolean }
  | { type: "unwrap"; path: NodePath; allowLayoutChange?: boolean }
  | { type: "move"; path: NodePath; parentId: string | null; index?: number; anchor?: NodePositionAnchor }
  /** インスタンスのページごとの値。undefined で解除する。 */
  | { type: "instanceProp"; path: NodePath; name: string; value: string | undefined }
  /** インスタンスを展開した element に置き換え、以後は部品の更新を受けない。 */
  | { type: "detach"; path: NodePath }
  /** 業務ブロックの表示領域の見た目。registry が許可したプロパティだけを通す。 */
  | { type: "slotStyle"; path: NodePath; slot: string; breakpoint: number | "base"; property: StyleProperty; value: StyleValue | undefined }
  /** 版履歴・端末内の退避から内容だけを戻す。対象・schemaVersion・revision は現在の文書のまま。 */
  | { type: "restore"; document: PageDocument }
  | MetaOperation;
type StableEditorOperation<T> = T extends { type: "text"; path: NodePath }
  ? Omit<T, "path"> & { parentId: string | null; childPath: NodePath; preconditions?: PageOperationPreconditions }
  : T extends { type: "style" | "attribute" | "prop"; path: NodePath }
    ? Omit<T, "path"> & { nodeId: string; preconditions?: PageOperationPreconditions }
    : T extends { path: NodePath }
      ? Omit<T, "path"> & { nodeId: string }
    : T;
/** 外部クライアント用の安定対象操作。textノードはIDを持たないため、IDを持つ親からの相対パスで指す。 */
export type EditorOperationById = StableEditorOperation<EditorOperation>;
/** undefined・空文字・false・空配列はその項目を削除する。 */
export type MetaOperation = { [K in keyof PageMeta]-?: { type: "meta"; field: K; value: PageMeta[K] | undefined } }[keyof PageMeta];
export type EditorOperationBlocks = Readonly<Record<string, BlockContract & Pick<EditorBlockRegistry[string], "lockedProps" | "styleProperties">>>;
export type EditorHistory = { past: PageDocument[]; present: PageDocument; future: PageDocument[] };
const documentFingerprints = new WeakMap<PageDocument, string>();
/** Editor documents are immutable snapshots; cache their serialized identity across renders and history checks. */
export function fingerprint(document: PageDocument): string {
  const cached = documentFingerprints.get(document);
  if (cached !== undefined) return cached;
  const value = JSON.stringify(document);
  documentFingerprints.set(document, value);
  return value;
}
/** Snapshot の任意 read-only 表示契約を、UI と Project adapter で共有して検証する。 */
export function parseEditorReadOnly(value: unknown): EditorReadOnly | undefined {
  if (value === undefined) return undefined;
  const source = record(value, "$snapshot.readOnly");
  keys(source, ["reason", "editUrl", "editLabel"], "$snapshot.readOnly");
  const reason = line(source.reason, "$snapshot.readOnly.reason", 500);
  let editUrl: string | undefined;
  if (source.editUrl !== undefined) {
    if (!isSafePublicUrl(source.editUrl) || source.editUrl.startsWith("#") || !(/^\/(?!\/)/u.test(source.editUrl) || /^https:\/\//iu.test(source.editUrl))) throw new Error("読み取り専用の編集先が正しくありません。");
    editUrl = source.editUrl;
  }
  if (source.editLabel !== undefined && editUrl === undefined) throw new Error("読み取り専用の編集先が正しくありません。");
  const editLabel = source.editLabel === undefined ? undefined : line(source.editLabel, "$snapshot.readOnly.editLabel", 80);
  return { reason, ...(editUrl ? { editUrl } : {}), ...(editLabel ? { editLabel } : {}) };
}
const implicitLocksByDocument = new WeakMap<PageDocument, WeakMap<EditorOperationBlocks, readonly EditorLock[]>>();
export function effectiveLocks(document: PageDocument, locks: readonly EditorLock[], blocks: EditorOperationBlocks): EditorLock[] {
  if (!Object.values(blocks).some(({ lockedProps }) => Object.keys(lockedProps ?? {}).length > 0)) return [...locks];
  let byBlocks = implicitLocksByDocument.get(document);
  if (!byBlocks) { byBlocks = new WeakMap(); implicitLocksByDocument.set(document, byBlocks); }
  let implicit = byBlocks.get(blocks);
  if (!implicit) {
    implicit = indexedNodes(document).flatMap(({ node }) => node.type === "component"
      ? Object.entries(blocks[node.block]?.lockedProps ?? {}).map(([name, reason]) => ({ nodeId: node.id, fields: [`props.${name}`], reason })) : []);
    byBlocks.set(blocks, implicit);
  }
  return [...locks, ...implicit];
}
const canonicalNodeKeys: Readonly<Record<PageNode["type"], readonly string[]>> = {
  text: ["type", "text"],
  element: ["type", "id", "name", "tag", "formCompletionPageId", "asset", "icon", "embed", "interaction", "attrs", "style", "children"],
  component: ["type", "id", "name", "block", "props", "style", "slots"],
  instance: ["type", "id", "name", "component", "props", "style"],
};
function orderedNode(node: PageNode, path: string): PageNode {
  const allowed = canonicalNodeKeys[node.type];
  if (Object.keys(node).some((key) => !allowed.includes(key))) fail(path, "unknown field");
  const keys = allowed.filter((key) => Object.hasOwn(node, key));
  if (Object.keys(node).every((key, index) => key === keys[index])) return node;
  return Object.fromEntries(keys.map((key) => [key, (node as unknown as Record<string, unknown>)[key]])) as unknown as PageNode;
}
/** New operations add properties in UI order; keep the same wire key order as parsePageDocument. */
function canonicalizeEditedDocument(document: PageDocument, original: PageDocument, blocks: EditorOperationBlocks, components?: ComponentLibrary): PageDocument {
  const originalNodes = new Map<string, PageNode>(), originalText = new WeakSet<object>();
  for (const { node } of indexedNodes(original)) {
    if (node.type === "text") originalText.add(node);
    else originalNodes.set(node.id, node);
  }
  const tokens = document.tokens;
  const textStyles = document.textStyles;
  const instanceTokens = components ? { ...components.tokens, ...tokens } : tokens;
  const normalizeNodes = (nodes: PageNode[], parentPath: string): PageNode[] => {
    let result: PageNode[] | undefined;
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]!;
      const path = `${parentPath}[${index}]`;
      const changed = node.type === "text" ? !originalText.has(node) : originalNodes.get(node.id) !== node;
      if (!changed) continue;
      let normalized = node;
      if (node.type === "element") {
        let element = node;
        const children = normalizeNodes(node.children, `${path}.children`);
        if (children !== node.children) element = { ...element, children };
        if (element.attrs && (element.tag === "input" || element.tag === "button") && element.attrs.type === undefined) {
          element = { ...element, attrs: { ...element.attrs, type: element.tag === "input" ? "text" : "button" } };
        }
        normalized = element;
      }
      if (normalized.type !== "text" && normalized.style) {
        const style = parseStyle(normalized.style, normalized.type === "instance" ? instanceTokens : tokens, `${parentPath}[${index}].style`, textStyles);
        normalized = { ...normalized, style };
      }
      if (normalized.type === "component") {
        const component = normalized, contract = blocks[component.block];
        if (contract) {
          const props: Record<string, PublicPropValue> = {};
          for (const name of Object.keys(contract.props)) if (Object.hasOwn(component.props, name)) props[name] = component.props[name]!;
          for (const name of Object.keys(component.props)) if (!Object.hasOwn(contract.props, name)) props[name] = component.props[name]!;
          const slots = Object.fromEntries(Object.entries(component.slots ?? {}).map(([name, style]) => [name, parseStyle(style, tokens, `${parentPath}[${index}].slots.${name}`, {}, false)]));
          normalized = { ...component, props, ...(Object.keys(slots).length ? { slots } : {}) };
          if (!Object.keys(slots).length) delete (normalized as ComponentNode).slots;
        }
      }
      normalized = orderedNode(normalized, path);
      if (normalized !== node) { result ??= nodes.slice(); result[index] = normalized; }
    }
    return result ?? nodes;
  };
  const body = normalizeNodes(document.body, "$.body");
  const normalizedTokens = document.tokens === original.tokens ? document.tokens : parseTokens(document.tokens, "$.tokens");
  const normalizedStyles = document.textStyles === original.textStyles ? document.textStyles : document.textStyles === undefined ? undefined : parseTextStyles(document.textStyles, normalizedTokens, "$.textStyles");
  const meta = document.meta === original.meta ? document.meta : document.meta === undefined ? undefined : parsePageMeta(document.meta);
  return {
    schemaVersion: document.schemaVersion, siteId: document.siteId, pageId: document.pageId, locale: document.locale,
    revision: document.revision, title: document.title,
    ...(meta && Object.keys(meta).length ? { meta } : {}), tokens: normalizedTokens,
    ...(normalizedStyles ? { textStyles: normalizedStyles } : {}), body,
  };
}
function fieldValue(node: PageNode, field: string): unknown {
  if (field === "*") return node;
  let value: unknown = node;
  for (const part of field.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
const mediaSourceFields = ["asset", "attrs.src", "attrs.srcSet"];
function assertLocks(before: PageDocument, after: PageDocument, locks: readonly EditorLock[]): void {
  if (!locks.length) return;
  const index = (document: PageDocument) => new Map(indexedNodes(document).flatMap(({ node }) => node.type === "text" ? [] : [[node.id, node] as const]));
  const previous = index(before), next = index(after);
  const resolved = (document: PageDocument, value: unknown): unknown => {
    if (Array.isArray(value)) return value.map((entry) => resolved(document, entry));
    if (!value || typeof value !== "object") return value;
    if ("token" in value && typeof value.token === "string") return document.tokens[value.token]?.value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolved(document, entry)]));
  };
  const projected = (document: PageDocument, node: PageNode, field: string): unknown => {
    if (node.type === "element" && (node.tag === "img" || node.tag === "video") && mediaSourceFields.includes(field)) {
      return [node.asset, node.attrs?.src, node.attrs?.srcSet];
    }
    const raw = resolved(document, fieldValue(node, field));
    if (node.type === "text" || field !== "*" && field !== "style" && !field.startsWith("style.")) return raw;
    const textStyle = node.style?.textStyle && document.textStyles?.[node.style.textStyle];
    if (!textStyle) return raw;
    const property = /^style\.(?:base|responsive)\.([A-Za-z]+)$/.exec(field)?.[1];
    const inherited = property ? { base: textStyle.base[property as keyof typeof textStyle.base], responsive: textStyle.responsive?.map((entry) => entry.declarations[property as keyof typeof entry.declarations]) } : textStyle;
    return [raw, resolved(document, inherited)];
  };
  for (const lock of locks) {
    const oldNode = previous.get(lock.nodeId), newNode = next.get(lock.nodeId);
    if (!oldNode) continue;
    if (!newNode || lock.fields.some((field) => JSON.stringify(projected(before, oldNode, field)) !== JSON.stringify(projected(after, newNode, field)))) throw new Error(`データ連動値は変更できません。${lock.reason}`);
  }
}
export function lockReason(document: PageDocument, path: NodePath, field: string, locks: readonly EditorLock[]): string | undefined {
  for (let depth = 1; depth <= path.length; depth++) {
    const node = nodeAt(document, path.slice(0, depth));
    if (node.type === "text") continue;
    const inherited = depth < path.length;
    const lock = locks.find((lock) => lock.nodeId === node.id && lock.fields.some((locked) => locked === "*" ||
      (inherited ? locked === "children" : field === locked || field.startsWith(`${locked}.`) || node.type === "element" && (node.tag === "img" || node.tag === "video") && mediaSourceFields.includes(field) && mediaSourceFields.includes(locked))));
    if (lock) return lock.reason;
  }
  return undefined;
}
type Declarations = Record<string, StyleValue>;
export type InheritedStyle = { value: StyleValue; from: number | "base"; via: "node" | "textStyle"; textStyle?: string };
/** 幅 start で、段 start の直接指定を除いて効く値。ノードの下位の段 → 文字スタイル（base と start 以下の responsive）の順。 */
export function inheritedStyle(document: PageDocument, node: ElementNode | ComponentNode | InstanceNode, property: StyleProperty, start: number): InheritedStyle | undefined {
  const style = node.style;
  for (const entry of [...(style?.responsive ?? [])].reverse()) {
    const value = entry.declarations[property];
    if (entry.minWidth < start && value !== undefined) return { value, from: entry.minWidth, via: "node" };
  }
  if (start > 0 && style?.base?.[property] !== undefined) return { value: style.base[property]!, from: "base", via: "node" };
  const name = style?.textStyle, textStyle = name ? document.textStyles?.[name] : undefined;
  if (!name || !textStyle || !(textStyleProperties as readonly string[]).includes(property)) return undefined;
  for (const entry of [...(textStyle.responsive ?? [])].reverse()) {
    const value = (entry.declarations as StyleDeclarations)[property];
    if (entry.minWidth <= start && value !== undefined) return { value, from: entry.minWidth, via: "textStyle", textStyle: name };
  }
  const value = (textStyle.base as StyleDeclarations)[property];
  return value === undefined ? undefined : { value, from: "base", via: "textStyle", textStyle: name };
}
// 広い幅に値が無いときに書く、tag に依存しない初期値。
const neutral: Partial<Record<StyleProperty, string | number>> = { width: "auto", height: "auto", minWidth: "auto", minHeight: "auto", flexBasis: "auto", maxWidth: "none", maxHeight: "none",
  top: "auto", right: "auto", bottom: "auto", left: "auto", zIndex: "auto", position: "static", flexDirection: "row", flexWrap: "nowrap", gap: 0, rowGap: 0, columnGap: 0,
  opacity: 1, borderRadius: 0, backgroundColor: "transparent", borderStyle: "none", overflow: "visible", objectFit: "fill" };
const boxGroup = (property: string) => /^margin(?:Top|Right|Bottom|Left)?$/.test(property) ? "margin"
  : /^padding(?:Top|Right|Bottom|Left)?$/.test(property) ? "padding"
    : property === "borderWidth" || /^border(?:Top|Right|Bottom|Left)Width$/.test(property) ? "borderWidth" : undefined;
const boxMembers = (group: string) => group === "borderWidth"
  ? ["borderWidth", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"] as StyleProperty[]
  : [group, ...["Top", "Right", "Bottom", "Left"].map((side) => `${group}${side}`)] as StyleProperty[];
function preserveRange(original: PageDocument, before: ElementNode | ComponentNode | InstanceNode, node: ElementNode | ComponentNode | InstanceNode, breakpoint: number | "base", until: number, values: Partial<Record<StyleProperty, StyleValue | undefined>>): void {
  if (!Number.isInteger(until) || until <= (breakpoint === "base" ? 0 : breakpoint)) throw new Error("反映する範囲が不正です。");
  const refuse = () => new Error(`広い幅（${until}px〜）の値が決まっていないため、この幅だけの指定にできません。先に「${until}px 以上」で値を入れてください。`);
  const own = (property: StyleProperty) => before.style?.responsive?.find((entry) => entry.minWidth === until)?.declarations[property] !== undefined;
  const properties = Object.keys(values) as StyleProperty[], writes: Declarations = {};
  // 余白と枠線幅は shorthand と上下左右が重なるため、組ごとに広い幅の値を保つ。
  const targets = new Set(properties.flatMap((property) => { const group = boxGroup(property); return group ? boxMembers(group) : [property]; }));
  const current = breakpoint === "base" ? before.style?.base : before.style?.responsive?.find((entry) => entry.minWidth === breakpoint)?.declarations;
  for (const property of targets) {
    // 無い値の削除は何も変えないので、広い幅に書き足さない。
    if (own(property) || Object.hasOwn(values, property) && values[property] === undefined && current?.[property] === undefined) continue;
    const group = boxGroup(property);
    const value = inheritedStyle(original, before, property, until)?.value ?? (group || values[property] === undefined ? undefined : neutral[property]);
    if (value !== undefined) writes[property] = cloneEditorValue(value);
    else if (!boxGroup(property) && values[property] !== undefined) throw refuse();
  }
  for (const group of new Set(properties.flatMap((property) => boxGroup(property) ?? []))) {
    const sides = boxMembers(group).slice(1);
    if (Object.hasOwn(values, group) && values[group] !== undefined || sides.some((side) => Object.hasOwn(values, side) && values[side] !== undefined)) {
      if (!sides.every((side) => own(group as StyleProperty) || Object.hasOwn(writes, group) || own(side) || Object.hasOwn(writes, side))) throw refuse();
    }
  }
  if (!Object.keys(writes).length) return;
  const responsive = (node.style ??= {}).responsive ??= [];
  let entry = responsive.find((item) => item.minWidth === until);
  if (!entry) { entry = { minWidth: until, declarations: {} }; responsive.push(entry); responsive.sort((a, b) => a.minWidth - b.minWidth); }
  Object.assign(entry.declarations, writes);
}
const styleName = (name: string) => { if (!/^[a-z][A-Za-z0-9-]*$/.test(name)) throw new Error("名前は英小文字で始まる英数字と - で指定してください。"); };
function eachDeclarations(document: PageDocument, visit: (declarations: Declarations) => void): void {
  for (const { node } of walkNodes(document)) if (node.type !== "text" && node.style) [node.style.base, ...(node.style.responsive ?? []).map((entry) => entry.declarations), ...Object.values(node.style.states ?? {})].forEach((values) => values && visit(values as Declarations));
  // 業務ブロックの表示領域も同じ参照を持てる（共通の値の削除では今の値へ置き換える）。
  for (const { node } of walkNodes(document)) if (node.type === "component") for (const style of Object.values(node.slots ?? {})) [style.base, ...(style.responsive ?? []).map((entry) => entry.declarations)].forEach((values) => values && visit(values as Declarations));
  for (const style of Object.values(document.textStyles ?? {})) [style.base, ...(style.responsive ?? []).map((entry) => entry.declarations)].forEach((values) => visit(values));
}
/** 見た目を変えずに文字スタイルを外す。ノードの値が効く幅（同じ段以下）に無いプロパティだけをコピーする。 */
function detachTextStyle(node: ElementNode | ComponentNode | InstanceNode, style: TextStyle): void {
  const own: NodeStyle = node.style ??= {}, original = cloneEditorValue(own);
  const has = (property: string, minWidth: number) => Object.hasOwn(original.base ?? {}, property) || (original.responsive ?? []).some((entry) => entry.minWidth <= minWidth && Object.hasOwn(entry.declarations, property));
  for (const [property, value] of Object.entries(style.base)) if (!Object.hasOwn(original.base ?? {}, property)) ((own.base ??= {}) as Declarations)[property] = cloneEditorValue(value);
  for (const entry of style.responsive ?? []) for (const [property, value] of Object.entries(entry.declarations)) {
    if (has(property, entry.minWidth)) continue;
    const responsive = own.responsive ??= [];
    let target = responsive.find((item) => item.minWidth === entry.minWidth);
    if (!target) { target = { minWidth: entry.minWidth, declarations: {} }; responsive.push(target); responsive.sort((a, b) => a.minWidth - b.minWidth); }
    (target.declarations as Declarations)[property] = cloneEditorValue(value);
  }
  delete own.textStyle;
}
/** 業務ブロックの styleProperties。"textStyle" "states" "appear" "hidden" はそれぞれの操作の許可。 */
function assertStyleProperties(node: ElementNode | ComponentNode | InstanceNode, properties: readonly string[], blocks: EditorOperationBlocks): void {
  const allowed = node.type === "component" ? blocks[node.block]?.styleProperties : undefined;
  if (allowed && properties.some((property) => !(allowed as readonly string[]).includes(property))) throw new Error("このブロックでは変更できない見た目です。");
}
function formFieldPairIndex(siblings: readonly PageNode[], node: PageNode, index: number): number {
  const controlId = node.type === "element" && ["input", "textarea", "select"].includes(node.tag) ? node.attrs?.id : undefined;
  const labelTarget = node.type === "element" && node.tag === "label" ? node.attrs?.htmlFor : undefined;
  return siblings.findIndex((candidate, at) => at !== index && candidate.type === "element" &&
    (typeof controlId === "string" && candidate.tag === "label" && candidate.attrs?.htmlFor === controlId ||
     typeof labelTarget === "string" && ["input", "textarea", "select"].includes(candidate.tag) && candidate.attrs?.id === labelTarget));
}

export type BoxGroupOperation = Extract<EditorOperation, { type: "wrap" | "unwrap" }>;
export const BOX_GROUP_NODE_LIMIT = 500;
export const BOX_GROUP_ID_PREFIX = "group_";
export class BoxGroupLayoutChange extends Error {
  constructor() { super("構造が変わり、要素の並び方や余白が変わる場合があります。"); }
}
export function boxGroupId(value: unknown, path: string): string {
  const id = identifier(value, path);
  if (!id.startsWith(BOX_GROUP_ID_PREFIX) || id.length === BOX_GROUP_ID_PREFIX.length) throw new Error("囲みボックスのIDは group_ で始め、後ろに文字を付けてください。");
  return id;
}
const boxGroupParents = new Set("div section article header footer main nav aside blockquote figure figcaption li dd dt details form".split(" "));
const boxGroupContextualTags = new Set("li dd dt source option legend summary figcaption".split(" "));
const blockFlowTags = new Set("div section article header footer main nav aside h1 h2 h3 h4 h5 h6 p ul ol dl blockquote figure form".split(" "));
const plainBoxKeys = new Set(["type", "id", "tag", "children"]);

function hasPlainBlockFlow(node: PageNode): boolean {
  if (node.type !== "element" || !blockFlowTags.has(node.tag) || node.interaction || node.embed) return false;
  const { style } = node;
  if (style?.appear || style?.hidden?.length || Object.keys(style?.states ?? {}).length) return false;
  const declarations = [style?.base ?? {}, ...(style?.responsive ?? []).map((rule) => rule.declarations)];
  return declarations.every((rule) => Object.entries(rule).every(([name, value]) =>
    (name === "display" && value === "block") || (textStyleProperties as readonly string[]).includes(name)));
}

function groupTargetPaths(document: PageDocument, operation: Extract<BoxGroupOperation, { type: "wrap" }>): NodePath[] {
  const wrapperId = boxGroupId(operation.wrapperId, "$.wrapperId");
  if (!Array.isArray(operation.nodeIds) || !operation.nodeIds.length || operation.nodeIds.length > BOX_GROUP_NODE_LIMIT) throw new Error(`囲む要素は1〜${BOX_GROUP_NODE_LIMIT}件指定してください。`);
  if (new Set(operation.nodeIds).size !== operation.nodeIds.length) throw new Error("囲む要素の指定が重複しています。");
  const paths = new Map<string, NodePath | null>();
  for (const { node, path } of walkNodes(document)) {
    if (node.type === "text") continue;
    if (node.id === wrapperId) throw new Error("囲みボックスのIDはこのページですでに使われています。");
    paths.set(node.id, paths.has(node.id) ? null : path);
  }
  return operation.nodeIds.map((id) => {
    const path = paths.get(id);
    if (!path) throw new Error("囲む要素が見つからないか、IDが重複しています。");
    return path;
  });
}

function editBoxGroup(document: PageDocument, operation: BoxGroupOperation, locks: readonly EditorLock[], components?: ComponentLibrary): boolean {
  const targets = operation.type === "wrap" ? groupTargetPaths(document, operation) : [operation.path];
  const first = targets[0]!, parentPath = first.slice(0, -1), parent = parentPath.length ? nodeAt(document, parentPath) : undefined;
  const siblings = siblingsAt(document, first), start = first.at(-1)!;
  let end = start, children: PageNode[], replacement: PageNode[];
  if (operation.type === "wrap") {
    if (targets.some((path) => path.length !== first.length || parentPath.some((index, depth) => path[depth] !== index))) throw new Error("同じ親の要素を選択してください。");
    if (targets.some((path, index) => index > 0 && path.at(-1)! < targets[index - 1]!.at(-1)!)) throw new Error("囲む要素を文書順に指定してください。");
    end = targets.at(-1)!.at(-1)!;
    children = siblings.slice(start, end + 1);
    if (children.filter((node) => node.type !== "text").length !== targets.length) throw new Error("間の要素も含めて、隣り合う要素を選択してください。");
    replacement = [{ type: "element", id: operation.wrapperId, tag: "div", children }];
  } else {
    const box = nodeAt(document, first);
    if (box.type !== "element" || box.tag !== "div" || !box.id.startsWith(BOX_GROUP_ID_PREFIX) || box.id.length === BOX_GROUP_ID_PREFIX.length ||
        Object.keys(box).some((key) => !plainBoxKeys.has(key))) throw new Error("囲み解除できるのは、属性や見た目の設定がない囲みボックスだけです。");
    children = box.children;
    replacement = children;
  }
  if ((parent && (parent.type !== "element" || !boxGroupParents.has(parent.tag))) || children.some((node) => {
    const tag = node.type === "element" ? node.tag : node.type === "instance" ? components?.components.find(({ id }) => id === node.component)?.root.tag : undefined;
    return tag !== undefined && boxGroupContextualTags.has(tag);
  })) throw new Error("この位置ではHTMLの入れ子が不正になるため、変更できません。");
  const ancestorLock = lockReason(document, first, "children", locks);
  const affected = siblings.slice(start, end + 1), ids = new Set(walkNodes({ ...document, body: affected }).flatMap(({ node }) => node.type === "text" ? [] : [node.id]));
  const lock = ancestorLock ?? locks.find(({ nodeId, fields }) => fields.length && ids.has(nodeId))?.reason;
  if (lock) throw new Error(`データ連動値を含む要素は移動できません。${lock}`);
  siblings.splice(start, end - start + 1, ...replacement);
  return (!!parent && !hasPlainBlockFlow(parent)) || !children.length || children.some((node) => !hasPlainBlockFlow(node));
}
/** components はインスタンスを含む文書の検証に使う、同じサイトの検証済みライブラリ。 */
export function editDocument(document: PageDocument, operation: EditorOperation, blocks: EditorOperationBlocks = {}, locks: readonly EditorLock[] = [], components?: ComponentLibrary, siteStyles?: SiteStyles, validateDocument = true): PageDocument {
  if (operation.type === "replaceChildren") {
    const target = nodeAt(document, operation.path);
    if (target.type === "element" && JSON.stringify(target.children) === JSON.stringify(operation.children)) return document;
  }
  const base = validateDocument ? resolvePageStyles(document, siteStyles) : document;
  const draft = createCopyOnWrite(base), allLocks = effectiveLocks(document, locks, blocks);
  const parentChildren = (path: NodePath): PageNode[] => siblingsAt(draft, path);
  const targetChildren = (id: string | null): PageNode[] => {
    if (id === null) return draft.body;
    const found = walkNodes(draft).find(({ node }) => node.type !== "text" && node.id === id)?.node;
    if (!found || found.type !== "element") throw new Error("追加・移動先が見つかりません。");
    return found.children;
  };
  const declarationsAt = (node: ElementNode | ComponentNode | InstanceNode, breakpoint: number | "base"): StyleDeclarations => {
    node.style ??= {};
    if (breakpoint === "base") return node.style.base ??= {};
    node.style.responsive ??= [];
    let entry = node.style.responsive.find((entry) => entry.minWidth === breakpoint);
    if (!entry) { entry = { minWidth: breakpoint, declarations: {} }; node.style.responsive.push(entry); }
    node.style.responsive.sort((a, b) => a.minWidth - b.minWidth);
    return entry.declarations;
  };
  const pruneResponsive = (node: ElementNode | ComponentNode | InstanceNode) => { if (node.style?.responsive) node.style.responsive = node.style.responsive.filter((entry) => Object.keys(entry.declarations).length); };
  let groupMayChangeLayout = false;
  if (operation.type === "wrap" || operation.type === "unwrap") groupMayChangeLayout = editBoxGroup(draft, operation, allLocks, components);
  else if (operation.type === "title") draft.title = operation.value;
  else if (operation.type === "restore") {
    const source = operation.document;
    if (!source || typeof source !== "object") throw new Error("復元する内容を確認できません。");
    draft.title = source.title; draft.tokens = cloneEditorValue(source.tokens); draft.body = cloneEditorValue(source.body);
    if (source.meta === undefined) delete draft.meta; else draft.meta = cloneEditorValue(source.meta);
    if (source.textStyles === undefined) delete draft.textStyles; else draft.textStyles = cloneEditorValue(source.textStyles);
  }
  else if (operation.type === "meta") {
    const meta: Record<string, unknown> = { ...draft.meta }, value = operation.value;
    if (value === undefined || value === "" || value === false && operation.field !== "targetReviewBeforePublish" || Array.isArray(value) && !value.length) delete meta[operation.field];
    else meta[operation.field] = cloneEditorValue(value);
    if (Object.keys(meta).length) draft.meta = meta as PageMeta; else delete draft.meta;
  }
  else if (operation.type === "add" || operation.type === "addMany") {
    const destination = targetChildren(operation.parentId), index = positionIndex(destination, operation.index, operation.anchor, true);
    if (!Number.isInteger(index) || index < 0 || index > destination.length) throw new Error("追加先の位置が不正です。");
    const additions = operation.type === "add" ? [operation.node] : operation.nodes;
    if (!additions.length) throw new Error("追加する要素がありません。");
    destination.splice(index, 0, ...cloneEditorValue(additions));
  } else if (operation.type === "replaceAsset") {
    const { from, to } = operation, same = (reference: AssetReference) => reference.provider === from.provider && reference.id === from.id;
    let count = 0;
    for (const { node } of walkNodes(draft)) {
      if (node.type === "text") continue;
      if (node.type === "element" && node.asset && same(node.asset)) { node.asset = cloneEditorValue(to); count++; }
      for (const declarations of [node.style?.base, ...(node.style?.responsive ?? []).map((entry) => entry.declarations)]) {
        if (declarations?.backgroundImage && declarations.backgroundImage !== "none" && same(declarations.backgroundImage.asset)) { declarations.backgroundImage = { asset: cloneEditorValue(to) }; count++; }
      }
    }
    const cover = draft.meta?.ogImage;
    if (cover && "asset" in cover && same(cover.asset)) { cover.asset = cloneEditorValue(to); count++; }
    if (!count) throw new Error("置き換えるアセットがこのページにありません。");
  } else if (operation.type === "token") {
    styleName(operation.name);
    const previous = draft.tokens[operation.name];
    if (previous && JSON.stringify(previous) !== JSON.stringify(operation.token)) {
      const usesToken = (value: unknown): boolean => !!value && typeof value === "object" && ("token" in value && value.token === operation.name || Object.values(value).some(usesToken));
      for (const lock of allLocks) {
        const node = walkNodes(document).find(({ node }) => node.type !== "text" && node.id === lock.nodeId)?.node;
        if (node && lock.fields.some((field) => usesToken(fieldValue(node, field)))) throw new Error(`データ連動値は変更できません。${lock.reason}`);
      }
    }
    if (operation.token) draft.tokens[operation.name] = cloneEditorValue(operation.token);
    else {
      const token = draft.tokens[operation.name];
      if (!token) throw new Error("共通の値が見つかりません。");
      eachDeclarations(draft, (values) => { for (const [property, value] of Object.entries(values)) if (typeof value === "object" && "token" in value && value.token === operation.name) values[property] = token.value; });
      delete draft.tokens[operation.name];
    }
  } else if (operation.type === "textStyle") {
    styleName(operation.name);
    const styles = draft.textStyles ??= {};
    if (operation.style) styles[operation.name] = cloneEditorValue(operation.style);
    else {
      const style = styles[operation.name];
      if (!style) throw new Error("テキストスタイルが見つかりません。");
      for (const { node } of walkNodes(draft)) if (node.type !== "text" && node.style?.textStyle === operation.name) detachTextStyle(node, style);
      delete styles[operation.name];
      if (!Object.keys(styles).length) delete draft.textStyles;
    }
  } else {
    const node = nodeAt(draft, operation.path);
    if (operation.type === "text") {
      if (node.type !== "text") throw new Error("テキストを選択してください。");
      node.text = operation.value;
    } else if (operation.type === "name") {
      if (node.type === "text") throw new Error("要素を選択してください。");
      if (operation.value === undefined) delete node.name;
      else node.name = parsePageNodeName(operation.value, "$operation.value");
    } else if (operation.type === "replaceChildren") {
      if (node.type !== "element") throw new Error("文字を編集できる要素を選択してください。");
      node.children = cloneEditorValue(operation.children);
    } else if (operation.type === "tag") {
      if (node.type !== "element" || !["p", "h1", "h2", "h3", "h4", "h5", "h6"].includes(node.tag)) throw new Error("見出し・段落を選択してください。");
      node.tag = operation.value;
    } else if (operation.type === "attribute") {
      if (node.type !== "element") throw new Error("要素を選択してください。");
      node.attrs ??= {};
      if (operation.value === "" && !(node.tag === "img" && operation.name === "alt")) delete node.attrs[operation.name];
      else node.attrs[operation.name] = operation.value;
      if (node.tag === "fieldset" && operation.name === "name") for (const child of node.children) {
        if (child.type === "element" && child.tag === "input" && child.attrs?.type === "radio") (child.attrs ??= {}).name = operation.value;
      }
      if (node.tag === "input" && operation.name === "type") {
        if (["password", "file"].includes(operation.value)) delete node.attrs.value;
        if (!["radio", "checkbox"].includes(operation.value)) delete node.attrs.checked;
        if (operation.value !== "file") delete node.attrs.accept;
      }
    } else if (operation.type === "booleanAttribute") {
      const video = node.type === "element" && node.tag === "video" && ["controls", "loop", "muted", "playsInline"].includes(operation.name);
      const form = node.type === "element" && ["input", "textarea", "select", "button", "option", "fieldset"].includes(node.tag) && ["required", "checked", "disabled"].includes(operation.name);
      if (!video && !form) throw new Error("この要素では切り替えられない設定です。");
      (node.attrs ??= {})[operation.name] = operation.value;
    } else if (operation.type === "loopBox") {
      if (node.type !== "element" || node.interaction?.type !== "loop-box") throw new Error("Loop Boxを選択してください。");
      if (!Number.isFinite(operation.speed) || operation.speed < 0 || operation.speed > 1000) throw new Error("速度は0〜1000px/秒で指定してください。");
      node.interaction = { type: "loop-box", speed: operation.speed, pauseOnHover: operation.pauseOnHover };
    } else if (operation.type === "formChoices") {
      if (node.type !== "element" || !["select", "fieldset"].includes(node.tag)) throw new Error("選択肢を持つ要素を選択してください。");
      const values = operation.values.map((value) => value.trim()).filter(Boolean);
      if (!values.length || values.length > 20 || values.some((value) => value.length > 120 || /[\u0000-\u001f\u007f]/u.test(value))) throw new Error("選択肢は1〜20件、各120文字以内で入力してください。");
      const used = new Set(walkNodes(draft).flatMap(({ node }) => node.type === "text" ? [] : [node.id]));
      let serial = 1;
      const nextId = (kind: string): string => { let value = ""; do value = `${node.id.slice(0, 58)}_${kind}${serial++}`; while (used.has(value)); used.add(value); return value; };
      if (node.tag === "select") node.children = values.map((value) => ({ type: "element", id: nextId("option"), tag: "option", attrs: { value }, children: [{ type: "text", text: value }] }));
      else {
        const legend = node.children[0], name = String(node.attrs?.name ?? "choice");
        node.children = [legend!, ...values.flatMap((value): PageNode[] => {
          const inputId = nextId("radio"), labelId = nextId("label");
          return [{ type: "element", id: inputId, tag: "input", attrs: { id: inputId, type: "radio", name, value }, children: [] },
            { type: "element", id: labelId, tag: "label", attrs: { htmlFor: inputId }, children: [{ type: "text", text: value }] }];
        })];
      }
    } else if (operation.type === "formCompletionPage") {
      if (node.type !== "element" || node.tag !== "form") throw new Error("フォームを選択してください。");
      if (operation.pageId === undefined) delete node.formCompletionPageId;
      else node.formCompletionPageId = operation.pageId;
    } else if (operation.type === "icon") {
      if (node.type !== "element" || node.tag !== "span" || !node.icon) throw new Error("アイコンを選択してください。");
      node.icon = operation.name;
    } else if (operation.type === "prop") {
      if (node.type !== "component") throw new Error("ブロックを選択してください。");
      if (operation.value === undefined) delete node.props[operation.name]; else node.props[operation.name] = operation.value;
    } else if (operation.type === "instanceProp") {
      if (node.type !== "instance") throw new Error("配置したコンポーネントを選択してください。");
      const props = { ...node.props };
      if (operation.value === undefined) delete props[operation.name]; else props[operation.name] = operation.value;
      if (Object.keys(props).length) node.props = props; else delete node.props;
    } else if (operation.type === "detach") {
      if (!components) throw new Error("コンポーネントライブラリを読み込めていません。");
      draft.body = detachInstance(finishCopyOnWrite(draft), operation.path, components, blocks).body;
    } else if (operation.type === "slotStyle") {
      if (node.type !== "component") throw new Error("ブロックを選択してください。");
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(operation.slot)) throw new Error("表示領域が見つかりません。");
      // 空になった指定は残さない。許可されたプロパティかどうかは最後の文書検証で確かめる。
      const slots = cloneEditorValue(node.slots ?? {}), current = slots[operation.slot] ?? {}, base = { ...current.base };
      const widths = (current.responsive ?? []).map((entry) => ({ minWidth: entry.minWidth, declarations: { ...entry.declarations } }));
      let declarations = base;
      if (operation.breakpoint !== "base") {
        let entry = widths.find((entry) => entry.minWidth === operation.breakpoint);
        if (!entry) { entry = { minWidth: operation.breakpoint, declarations: {} }; widths.push(entry); widths.sort((a, b) => a.minWidth - b.minWidth); }
        declarations = entry.declarations;
      }
      if (operation.value === undefined) delete declarations[operation.property]; else declarations[operation.property] = operation.value;
      const responsive = widths.filter((entry) => Object.keys(entry.declarations).length);
      const next = { ...(Object.keys(base).length ? { base } : {}), ...(responsive.length ? { responsive } : {}) };
      if (Object.keys(next).length) slots[operation.slot] = next; else delete slots[operation.slot];
      if (Object.keys(slots).length) node.slots = slots; else delete node.slots;
    } else if (operation.type === "motionPreset") {
      if (node.type === "text") throw new Error("親要素の見た目を編集してください。");
      if (operation.style) assertMotionStylePatch(operation.style);
      if (operation.previous) assertMotionStylePatch(operation.previous);
      const before = node.style, patch = operation.style, previous = operation.previous;
      const changedBase = new Set<string>([...Object.keys(previous?.base ?? {}), ...Object.keys(patch?.base ?? {})]);
      assertStyleProperties(node, [
        ...changedBase,
        ...(previous?.states || patch?.states ? ["states"] : []),
        ...(previous?.appear || patch?.appear ? ["appear"] : [])
      ], blocks);
      const base = { ...before?.base };
      for (const [property, value] of Object.entries(previous?.base ?? {})) if (sameMotionValue(base[property as StyleProperty], value)) delete base[property as StyleProperty];
      Object.assign(base, cloneEditorValue(patch?.base ?? {}));
      const states = cloneEditorValue(before?.states ?? {});
      for (const [state, declarations] of Object.entries(previous?.states ?? {})) {
        const current = { ...states[state as StateName] };
        for (const [property, value] of Object.entries(declarations ?? {})) if (sameMotionValue(current[property as StateProperty], value)) delete current[property as StateProperty];
        if (Object.keys(current).length) states[state as StateName] = current; else delete states[state as StateName];
      }
      for (const [state, declarations] of Object.entries(patch?.states ?? {})) states[state as StateName] = { ...states[state as StateName], ...cloneEditorValue(declarations) };
      let appear = cloneEditorValue(before?.appear);
      if (previous?.appear && sameMotionValue(appear, previous.appear)) appear = undefined;
      if (patch?.appear) appear = cloneEditorValue(patch.appear);
      const style: NodeStyle = {
        ...(before?.textStyle ? { textStyle: before.textStyle } : {}),
        ...(Object.keys(base).length ? { base } : {}),
        ...(before?.responsive?.length ? { responsive: cloneEditorValue(before.responsive) } : {}),
        ...(Object.keys(states).length ? { states } : {}),
        ...(appear ? { appear } : {}),
        ...(before?.hidden?.length ? { hidden: cloneEditorValue(before.hidden) } : {})
      };
      if (Object.keys(style).length) node.style = style; else delete node.style;
      // trusted host の定義でも値はその場で検証し、関数末尾の所有権復元後にも同じ validator を通す。
      if (validateDocument) validatePageDocument(finishCopyOnWrite(draft), blocks, { ...(components ? { components } : {}), ...(siteStyles ? { siteStyles } : {}) });
    } else if (operation.type === "state") {
      if (node.type === "text") throw new Error("親要素の見た目を編集してください。");
      assertStyleProperties(node, ["states"], blocks);
      const states = (node.style ??= {}).states ??= {};
      for (const name of new Set([operation.state, ...(operation.also ?? [])])) {
        if (!stateNames.includes(name)) throw new Error("状態が不正です。");
        const values: Declarations = { ...states[name] };
        for (const [property, value] of Object.entries(operation.values)) if (value === undefined) delete values[property]; else values[property] = cloneEditorValue(value);
        if (Object.keys(values).length) states[name] = values; else delete states[name];
      }
      if (!Object.keys(states).length) delete node.style.states;
    } else if (operation.type === "appear" || operation.type === "hidden") {
      if (node.type === "text") throw new Error("親要素の見た目を編集してください。");
      assertStyleProperties(node, [operation.type], blocks);
      const style = node.style ??= {};
      if (operation.type === "appear") { if (operation.value) style.appear = cloneEditorValue(operation.value); else delete style.appear; }
      else if (operation.ranges?.length) style.hidden = cloneEditorValue([...operation.ranges]); else delete style.hidden;
    } else if (operation.type === "nodeTextStyle") {
      if (node.type === "text") throw new Error("親要素の見た目を編集してください。");
      assertStyleProperties(node, ["textStyle"], blocks);
      if (operation.name !== undefined) (node.style ??= {}).textStyle = operation.name;
      else if (node.style?.textStyle) {
        const style = draft.textStyles?.[node.style.textStyle];
        if (operation.detach && style) detachTextStyle(node, style); else delete node.style.textStyle;
      }
    } else if (operation.type === "style" || operation.type === "styles" || operation.type === "styleRange" || operation.type === "resize") {
      if (node.type === "text") throw new Error("親要素の見た目を編集してください。");
      if (operation.type === "resize" && ![operation.width, operation.height].every((value) => Number.isFinite(value) && value >= 1 && value <= 10000)) throw new Error("幅と高さは1〜10000pxで指定してください。");
      const values: Partial<Record<StyleProperty, StyleValue | undefined>> = operation.type === "style" ? { [operation.property]: operation.value }
        : operation.type === "resize" ? { width: Math.round(operation.width), height: Math.round(operation.height) } : operation.values;
      const until = operation.type === "styleRange" ? operation.until : operation.type === "resize" ? operation.until : undefined;
      assertStyleProperties(node, Object.keys(values), blocks);
      if (until !== undefined) preserveRange(resolvePageStyles(document, siteStyles), nodeAt(document, operation.path) as ElementNode | ComponentNode | InstanceNode, node, operation.breakpoint, until, values);
      const declarations = declarationsAt(node, operation.breakpoint);
      for (const [property, value] of Object.entries(values) as [StyleProperty, StyleValue | undefined][]) if (value === undefined) delete declarations[property]; else declarations[property] = value;
      pruneResponsive(node);
    } else if (operation.type === "image") {
      if (node.type !== "element" || node.tag !== "img") throw new Error("画像を選択してください。");
      node.attrs ??= {};
      if ("asset" in operation.source) { node.asset = cloneEditorValue(operation.source.asset); delete node.attrs.src; delete node.attrs.srcSet; }
      else {
        node.attrs.src = operation.source.src;
        if (operation.source.srcset === undefined) delete node.attrs.srcSet; else node.attrs.srcSet = operation.source.srcset;
        delete node.asset;
      }
      if (operation.alt !== undefined) node.attrs.alt = operation.alt;
    } else if (operation.type === "video") {
      if (node.type !== "element" || node.tag !== "video") throw new Error("動画を選択してください。");
      node.attrs ??= {};
      if ("asset" in operation.source) { node.asset = cloneEditorValue(operation.source.asset); delete node.attrs.src; }
      else { if (operation.source.src) node.attrs.src = operation.source.src; else delete node.attrs.src; delete node.asset; }
    } else if (operation.type === "embedSource") {
      if (node.type !== "element" || !node.embed) throw new Error("埋め込みを選択してください。");
      if (operation.source === "") delete node.embed.source;
      else node.embed.source = normalizeEmbedSource(node.embed.provider, operation.source);
    } else if (operation.type === "embedTitle") {
      if (node.type !== "element" || !node.embed) throw new Error("埋め込みを選択してください。");
      node.embed.title = operation.title;
    } else if (operation.type === "background") {
      if (node.type === "text") throw new Error("親要素の見た目を編集してください。");
      const declarations = declarationsAt(node, operation.breakpoint);
      if (operation.asset === undefined) delete declarations.backgroundImage; else declarations.backgroundImage = { asset: cloneEditorValue(operation.asset) };
      pruneResponsive(node);
    } else if (operation.type === "remove") {
      const siblings = parentChildren(operation.path), index = operation.path.at(-1)!;
      const pair = formFieldPairIndex(siblings, node, index);
      for (const at of [index, pair].filter((at) => at >= 0).sort((left, right) => right - left)) siblings.splice(at, 1);
    }
    else if (operation.type === "duplicate") {
      const siblings = parentChildren(operation.path), index = operation.path.at(-1)!;
      const pair = formFieldPairIndex(siblings, node, index);
      const originals = pair < 0 ? [node] : [siblings[Math.min(index, pair)]!, siblings[Math.max(index, pair)]!];
      const subtree = originals.flatMap((entry) => entry.type === "text" ? [] : walkNodes({ ...draft, body: [entry] }));
      if (subtree.some(({ node }) => node.type !== "text" && allLocks.some((lock) => lock.nodeId === node.id))) throw new Error("データ連動値を含む要素は複製できません。");
      const copies = normalizeNodeFragment(cloneEditorValue(originals), finishCopyOnWrite(draft));
      siblings.splice(Math.max(index, pair) + 1, 0, ...copies);
    } else if (operation.type === "move") {
      if (operation.parentId && walkNodes({ ...draft, body: [node] }).some(({ node }) => node.type !== "text" && node.id === operation.parentId)) throw new Error("要素を自分の内側へ移動できません。");
      parentChildren(operation.path).splice(operation.path.at(-1)!, 1);
      const destination = targetChildren(operation.parentId), index = positionIndex(destination, operation.index, operation.anchor, false);
      destination.splice(index, 0, node);
    }
  }
  let candidate = finishCopyOnWrite(draft);
  if (candidate === base) return document;
  if (validateDocument) {
    candidate = canonicalizeEditedDocument(candidate, document, blocks, components);
    validatePageDocument(candidate, blocks, { ...(components ? { components } : {}), ...(siteStyles ? { siteStyles } : {}) });
  }
  assertLocks(validateDocument ? resolvePageStyles(document, siteStyles) : document, candidate, allLocks);
  if (groupMayChangeLayout && (operation.type === "wrap" || operation.type === "unwrap") && operation.allowLayoutChange !== true) throw new BoxGroupLayoutChange();
  const ownership = operation.type === "restore" ? operation.document : operation.type === "token" && operation.token ? { ...document, tokens: { ...document.tokens, [operation.name]: operation.token } }
    : operation.type === "textStyle" && operation.style ? { ...document, textStyles: { ...document.textStyles, [operation.name]: operation.style } } : { ...document };
  if (operation.type === "token" && !operation.token) { ownership.tokens = { ...ownership.tokens }; delete ownership.tokens[operation.name]; }
  if (operation.type === "textStyle" && !operation.style && ownership.textStyles) { ownership.textStyles = { ...ownership.textStyles }; delete ownership.textStyles[operation.name]; }
  if (!siteStyles) return candidate;
  const result = retainPageStyles(candidate, ownership, siteStyles);
  if (validateDocument) validatePageDocument(result, blocks, { ...(components ? { components } : {}), siteStyles });
  return result;
}
function positionIndex(destination: readonly PageNode[], index: number | undefined, anchor: NodePositionAnchor | undefined, optional: boolean): number {
  if (index !== undefined && anchor !== undefined) throw new Error("位置は index または anchor のどちらか一方で指定してください。");
  if (anchor !== undefined) {
    if ("edge" in anchor) return anchor.edge === "start" ? 0 : destination.length;
    const nodeId = "before" in anchor ? anchor.before : anchor.after;
    const at = destination.findIndex((node) => node.type !== "text" && node.id === nodeId);
    if (at < 0) throw new Error("位置アンカーが見つかりません。");
    return "before" in anchor ? at : at + 1;
  }
  if (index === undefined && optional) return destination.length;
  if (!Number.isInteger(index) || index! < 0 || index! > destination.length) throw new Error(optional ? "追加先の位置が不正です。" : "移動先の位置が不正です。");
  return index!;
}
function pathForNodeId(document: PageDocument, nodeId: string): NodePath {
  if (typeof nodeId !== "string" || !nodeId) throw new Error("対象ノードIDが正しくありません。");
  const matches = indexedNodesById(document, nodeId);
  if (matches.length !== 1) throw new Error("対象ノードが見つからないか、IDが重複しています。");
  return matches[0]!.path;
}
function pathForTextTarget(document: PageDocument, parentId: string | null, childPath: NodePath): NodePath {
  if (!Array.isArray(childPath) || childPath.length === 0) throw new Error("テキスト対象の相対パスが正しくありません。");
  const parentPath = parentId === null ? [] : pathForNodeId(document, parentId);
  if (parentId !== null && nodeAt(document, parentPath).type !== "element") throw new Error("テキスト対象の親要素が正しくありません。");
  const path = [...parentPath, ...childPath];
  if (nodeAt(document, path).type !== "text") throw new Error("対象パスはテキストノードを指していません。");
  return path;
}
/** Stable IDで操作対象を解決し、GUIと同じ検証済み文書操作を適用する。 */
export function editDocumentById(document: PageDocument, operation: EditorOperationById, blocks: EditorOperationBlocks = {}, locks: readonly EditorLock[] = [], components?: ComponentLibrary, siteStyles?: SiteStyles, validateDocument = true): PageDocument {
  if (operation.type === "text") {
    if (!("parentId" in operation) || !("childPath" in operation)) throw new Error("テキスト対象は親IDと相対パスで指定してください。");
    const { parentId, childPath, preconditions: _preconditions, ...change } = operation;
    const path = pathForTextTarget(document, parentId, childPath);
    return editDocument(document, { ...change, path } as EditorOperation, blocks, locks, components, siteStyles, validateDocument);
  }
  if ("nodeId" in operation) {
    const { nodeId, preconditions: _preconditions, ...change } = operation as typeof operation & { preconditions?: PageOperationPreconditions };
    const path = pathForNodeId(document, nodeId);
    return editDocument(document, { ...change, path } as EditorOperation, blocks, locks, components, siteStyles, validateDocument);
  }
  if ("path" in operation) throw new Error("外部操作では配列位置でなく安定した対象IDを指定してください。");
  return editDocument(document, operation as EditorOperation, blocks, locks, components, siteStyles, validateDocument);
}
export function commitHistory(history: EditorHistory, document: PageDocument): EditorHistory {
  if (document === history.present || fingerprint(document) === fingerprint(history.present)) return history;
  return { past: [...history.past.slice(-49), history.present], present: document, future: [] };
}
/** 内容と履歴の順序を保ち、保存先が採番した revision を編集の新しい基準にする。 */
export function acceptSavedRevision(history: EditorHistory, submitted: PageDocument, revision: number): { history: EditorHistory; saved: string } {
  if (!Number.isSafeInteger(revision) || revision <= submitted.revision || history.present.revision !== submitted.revision) throw new Error("保存後の revision が一致しません。編集内容は保持されています。");
  const rebase = (document: PageDocument): PageDocument => ({ ...document, revision });
  return {
    history: { past: history.past.map(rebase), present: rebase(history.present), future: history.future.map(rebase) },
    saved: fingerprint(rebase(submitted))
  };
}
export function travelHistory(history: EditorHistory, direction: "undo" | "redo", blocks: EditorOperationBlocks, locks: readonly EditorLock[], components?: ComponentLibrary, siteStyles?: SiteStyles): EditorHistory {
  const target = direction === "undo" ? history.past.at(-1) : history.future[0];
  if (!target) return history;
  parsePageDocument(target, blocks, { ...(components ? { components } : {}), ...(siteStyles ? { siteStyles } : {}) });
  assertLocks(resolvePageStyles(history.present, siteStyles), resolvePageStyles(target, siteStyles), effectiveLocks(history.present, locks, blocks));
  return direction === "undo" ? { past: history.past.slice(0, -1), present: target, future: [history.present, ...history.future] }
    : { past: [...history.past, history.present], present: target, future: history.future.slice(1) };
}
export function sameTarget(left: EditorTarget, right: EditorTarget): boolean {
  return left.siteId === right.siteId && left.pageId === right.pageId && left.locale === right.locale;
}
export function validateReleasePlan(plan: EditorReleasePlan, request: EditorReleaseRequest, site: EditorSite): void {
  if (!isSafeHttpsOrigin(plan.domain) || !site.domains.includes(plan.domain) || !sameTarget(plan.target, request.target) || plan.expectedVersion !== request.expectedVersion || plan.action !== request.action || plan.revision !== request.revision ||
    plan.componentsVersion !== request.componentsVersion || plan.presentationVersion !== request.presentationVersion ||
    JSON.stringify(plan.siteStylesRevision) !== JSON.stringify(request.siteStylesRevision) || plan.sitePublicationEpoch !== request.sitePublicationEpoch ||
    typeof plan.confirmationToken !== "string" || !plan.confirmationToken || !Array.isArray(plan.changes) ||
    plan.changes.some((change) => !change || typeof change.path !== "string" || typeof change.before !== "string" || typeof change.after !== "string") ||
    (request.action === "rollback" && (!Number.isSafeInteger(request.revision) || request.revision! < 1)) ||
    (plan.url !== undefined && !(planText(plan.url, 2048) && plan.url.startsWith(`${plan.domain}/`))) ||
    (plan.affected !== undefined && !(Array.isArray(plan.affected) && plan.affected.length <= 100 && plan.affected.every((item: unknown) => {
      const { kind, name, detail } = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      return (kind === "shared" || kind === "page" || kind === "site") && planText(name, 120) && name.length > 0 && (detail === undefined || planText(detail, 300));
    })))) throw new Error("公開対象または差分確認の情報が一致しません。再取得してください。");
}
const changeTarget = (change: EditorPageChange): EditorTarget | undefined => change.action === "create" ? undefined : change.action === "duplicate" ? change.source : change.target;
type PageChangeProblem = { field: "title" | "path" | "change"; message: string };
/** 入力欄ごとに表示するための問題。対象・権限の問題は change として1件だけ返す。 */
export function pageChangeProblems(change: EditorPageChange, pages: readonly EditorPage[], site: EditorSite): PageChangeProblem[] {
  const target = changeTarget(change), siteId = target ? target.siteId : change.action === "create" ? change.siteId : undefined;
  if (siteId !== site.id) return [{ field: "change", message: "別のサイトのページは操作できません。" }];
  const page = target && pages.find((page) => sameTarget(page, target));
  if (target && !page) return [{ field: "change", message: "対象のページが見つかりません。ページ一覧を再読込してください。" }];
  if (page && (page.kind ?? "page") !== "page") return [{ field: "change", message: `${page.kind === "shared" ? "コンポーネント" : "テンプレート"}はページの操作で変更できません。` }];
  if (change.action === "visibility") {
    if (change.visibility !== "public" && change.visibility !== "private") return [{ field: "change", message: "公開状態を選択してください。" }];
    if ((page?.visibility ?? "public") === change.visibility) return [{ field: "change", message: change.visibility === "private" ? "このページはすでに非公開です。" : "このページはすでに公開状態です。" }];
    return [];
  }
  const locale = page ? page.locale : change.action === "create" ? change.locale : "";
  if (!/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(locale)) return [{ field: "change", message: "ページの言語を確認できません。" }];
  const problems: PageChangeProblem[] = [];
  if (typeof change.title !== "string" || !change.title.trim()) problems.push({ field: "title", message: "ページ名を入力してください。" });
  else if (change.title.length > 120) problems.push({ field: "title", message: "ページ名は120文字以内にしてください。" });
  else if (/[\u0000-\u001f\u007f]/u.test(change.title)) problems.push({ field: "title", message: "ページ名に改行や制御文字は使えません。" });
  const pathProblem = validatePagePath(change.path);
  const conflict = pathProblem ? undefined : findPathConflict(pages, { siteId: site.id, locale, path: change.path, ...(change.action === "update" && page ? { exceptPageId: page.pageId } : {}) });
  if (pathProblem) problems.push({ field: "path", message: pathProblem });
  else if (conflict) problems.push({ field: "path", message: conflict.kind === "template" ? `テンプレート「${conflict.title}」の URL と重なります。` : `「${conflict.title}」と同じ URL です。` });
  if (!problems.length && change.action === "update" && page && page.title === change.title && page.path === change.path) problems.push({ field: "change", message: "ページ名か URL パスを変更してください。" });
  return problems;
}
/** UI 補助の事前確認。ホストは applyPageChange でも同じ規則と予約パスを検査する。 */
export function checkPageChange(change: EditorPageChange, pages: readonly EditorPage[], site: EditorSite): string | undefined {
  return pageChangeProblems(change, pages, site)[0]?.message;
}
const planText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
function normalizedTarget(value: unknown): EditorTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { siteId, pageId, locale } = value as Record<string, unknown>;
  return typeof siteId === "string" && typeof pageId === "string" && typeof locale === "string" ? { siteId, pageId, locale } : undefined;
}
/** 既知の項目だけを持つ変更要求。形が合わなければ undefined。 */
export function normalizePageChange(value: unknown): EditorPageChange | undefined {
  if (!value || typeof value !== "object") return undefined;
  const change = value as Record<string, unknown>, { title, path } = change;
  if (change.action === "visibility") {
    const target = normalizedTarget(change.target);
    return target && (change.visibility === "public" || change.visibility === "private") ? { action: "visibility", target, visibility: change.visibility } : undefined;
  }
  if (typeof title !== "string" || typeof path !== "string") return undefined;
  if (change.action === "create") return typeof change.siteId === "string" && typeof change.locale === "string" ? { action: "create", siteId: change.siteId, locale: change.locale, title, path } : undefined;
  if (change.action === "duplicate") { const source = normalizedTarget(change.source); return source && { action: "duplicate", source, title, path }; }
  if (change.action === "update") { const target = normalizedTarget(change.target); return target && { action: "update", target, title, path }; }
  return undefined;
}
/** 要求と一致し、許可済みドメインの影響だけを持つ plan の複製を返す。 */
export function validatePageChangePlan(plan: unknown, change: EditorPageChange, site: EditorSite): EditorPageChangePlan {
  const invalid = (): never => { throw new Error("ページ変更の対象または影響の情報が一致しません。再取得してください。"); };
  if (!plan || typeof plan !== "object") return invalid();
  const source = plan as Record<string, unknown>, domain = source.domain, requested = normalizePageChange(change), returned = normalizePageChange(source.change);
  const hasManagementMetadata = source.expectedVersion !== undefined || source.operationId !== undefined;
  if (hasManagementMetadata && (!planText(source.expectedVersion, 200) || typeof source.operationId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(source.operationId))) return invalid();
  if (!isSafeHttpsOrigin(domain) || !site.domains.includes(domain) || !requested || !returned || JSON.stringify(requested) !== JSON.stringify(returned)) return invalid();
  const target = changeTarget(requested);
  if ((target ? target.siteId : requested.action === "create" ? requested.siteId : "") !== site.id) return invalid();
  if (typeof source.confirmationToken !== "string" || !source.confirmationToken || source.confirmationToken.length > 4096) return invalid();
  const impact = source.impact as Record<string, unknown> | null | undefined;
  if (!impact || typeof impact !== "object") return invalid();
  const pageUrl = (value: unknown): string => planText(value, 2048) && value.startsWith(`${domain}/`) ? value : invalid();
  const texts = (value: unknown): string[] => Array.isArray(value) && value.length <= 100 && value.every((item) => planText(item, 300)) ? [...value] : invalid();
  const redirect = impact.redirect as Record<string, unknown> | null | undefined;
  if (redirect !== undefined && (!redirect || typeof redirect !== "object" || !planText(redirect.from, 2048) || !planText(redirect.to, 2048))) return invalid();
  if (!Array.isArray(impact.linkedFrom) || impact.linkedFrom.length > 500) return invalid();
  const linkedFrom = (impact.linkedFrom as unknown[]).map((entry) => {
    const { pageId, locale, title, count } = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    if (typeof pageId !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(pageId) || !planText(locale, 40) || !planText(title, 300) ||
      typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return invalid();
    return { pageId, locale, title, count };
  });
  const result: EditorPageImpact = {
    ...(impact.before === undefined ? {} : { before: pageUrl(impact.before) }),
    ...(impact.after === undefined ? {} : { after: pageUrl(impact.after) }),
    ...(redirect ? { redirect: { from: redirect.from as string, to: redirect.to as string } } : {}),
    linkedFrom, navigation: texts(impact.navigation), notes: texts(impact.notes)
  };
  return { change: requested, confirmationToken: source.confirmationToken, domain, impact: result,
    ...(hasManagementMetadata ? { expectedVersion: source.expectedVersion as string, operationId: source.operationId as string } : {}) };
}
export function newElement(tag: ElementNode["tag"], id: string): ElementNode {
  return tag === "img" ? { type: "element", id, tag, attrs: { src: "/placeholder.webp", alt: "画像の説明" }, children: [] }
    : tag === "video" ? { type: "element", id, tag, attrs: { "aria-label": "動画", controls: true, preload: "metadata", playsInline: true }, children: [] }
    : { type: "element", id, tag, ...(tag === "a" ? { attrs: { href: "/" } } : {}), children: tag === "section" ? [] : [{ type: "text", text: tag === "a" ? "リンク" : "新しいテキスト" }] };
}
