import { copyId, walkNodes } from "./node-tree.js";
import type { AssetReference, PageDocument, PageNode } from "./types.js";

export const EDITOR_NODE_CLIPBOARD_TYPE = "application/x-niho-web-nodes+json";
const EDITOR_NODE_CLIPBOARD_VERSION = 1;
export const EDITOR_NODE_CLIPBOARD_MAX_LENGTH = 5_000_000;
const clipboardKeys = ["version", "siteId", "nodes", "tokenNames", "textStyleNames", "assets"];

export type EditorNodeClipboard = {
  version: 1;
  siteId: string;
  nodes: readonly PageNode[];
  tokenNames: readonly string[];
  textStyleNames: readonly string[];
  assets: readonly AssetReference[];
};

let inMemoryClipboard: EditorNodeClipboard | null = null;
export function rememberEditorNodeClipboard(value: EditorNodeClipboard): void { inMemoryClipboard = structuredClone(value); }
export function readRememberedEditorNodeClipboard(): EditorNodeClipboard | null { return inMemoryClipboard && structuredClone(inMemoryClipboard); }

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function tokenNames(nodes: readonly PageNode[]): string[] {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!object(value)) return;
    if (typeof value.token === "string") names.add(value.token);
    Object.values(value).forEach(visit);
  };
  nodes.forEach(visit);
  return [...names].sort();
}

function textStyleNames(nodes: readonly PageNode[]): string[] {
  const names = new Set<string>();
  const visit = (node: PageNode): void => {
    if (node.type === "text") return;
    if (node.style?.textStyle) names.add(node.style.textStyle);
    if (node.type === "component") for (const style of Object.values(node.slots ?? {})) if (style.textStyle) names.add(style.textStyle);
    if (node.type === "element") node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return [...names].sort();
}

function assetReferences(nodes: readonly PageNode[]): AssetReference[] {
  const references = new Map<string, AssetReference>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!object(value)) return;
    if (typeof value.provider === "string" && typeof value.id === "string" && Object.keys(value).length === 2) {
      references.set(`${value.provider}:${value.id}`, { provider: value.provider, id: value.id });
      return;
    }
    Object.values(value).forEach(visit);
  };
  nodes.forEach(visit);
  return [...references.values()].sort((left, right) => {
    const a = `${left.provider}:${left.id}`, b = `${right.provider}:${right.id}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function createEditorNodeClipboard(siteId: string, nodes: readonly PageNode[]): EditorNodeClipboard {
  if (!siteId || !nodes.length || nodes.some((node) => node.type === "text")) throw new Error("コピーする要素がありません。");
  const subtrees = structuredClone(nodes);
  return {
    version: EDITOR_NODE_CLIPBOARD_VERSION,
    siteId,
    nodes: subtrees,
    tokenNames: tokenNames(subtrees),
    textStyleNames: textStyleNames(subtrees),
    assets: assetReferences(subtrees),
  };
}

/** OS クリップボードの JSON を、manifest の欠落や改変を検出してから利用する。 */
export function parseEditorNodeClipboard(value: unknown): EditorNodeClipboard {
  const validIdentifier = (entry: unknown): entry is string => typeof entry === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(entry);
  if (!object(value) || value.version !== EDITOR_NODE_CLIPBOARD_VERSION || !validIdentifier(value.siteId) ||
      Object.keys(value).some((key) => !clipboardKeys.includes(key)) ||
      !Array.isArray(value.nodes) || !value.nodes.length || !Array.isArray(value.tokenNames) || !value.tokenNames.every((entry) => typeof entry === "string") ||
      !Array.isArray(value.textStyleNames) || !value.textStyleNames.every((entry) => typeof entry === "string") || !Array.isArray(value.assets) ||
      !value.assets.every((entry) => object(entry) && Object.keys(entry).length === 2 && validIdentifier(entry.provider) &&
        typeof entry.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(entry.id))) {
    throw new Error("NIHO Web のコピー形式を読み取れません。");
  }
  let count = 0;
  const assertNode = (node: unknown, depth = 0): void => {
    if (++count > 5000 || depth > 48) throw new Error("コピーする要素が文書の上限を超えています。");
    if (!object(node) || !["text", "element", "component", "instance"].includes(String(node.type))) throw new Error("NIHO Web のコピー形式を読み取れません。");
    if (node.type === "text") { if (typeof node.text !== "string") throw new Error("NIHO Web のコピー形式を読み取れません。"); return; }
    if (typeof node.id !== "string" || !node.id) throw new Error("NIHO Web のコピー形式を読み取れません。");
    if (node.type === "element") {
      if (!Array.isArray(node.children)) throw new Error("NIHO Web のコピー形式を読み取れません。");
      node.children.forEach((child) => assertNode(child, depth + 1));
    }
  };
  value.nodes.forEach(assertNode);
  const validStyleName = (entry: unknown): entry is string => typeof entry === "string" && /^([a-z][A-Za-z0-9-]{0,79})$/u.test(entry);
  if (!value.tokenNames.every(validStyleName) || !value.textStyleNames.every(validStyleName)) throw new Error("コピー内容の参照名が正しくありません。");
  const parsed = createEditorNodeClipboard(value.siteId, value.nodes as PageNode[]);
  const sameStrings = (left: readonly string[], right: readonly string[]) => {
    const a = [...left].sort(), b = [...right].sort();
    return a.length === b.length && a.every((entry, index) => entry === b[index]);
  };
  const declaredAssets = value.assets.map((asset) => `${asset.provider}:${asset.id}`).sort();
  const actualAssets = parsed.assets.map((asset) => `${asset.provider}:${asset.id}`).sort();
  if (!sameStrings(value.tokenNames, parsed.tokenNames) || !sameStrings(value.textStyleNames, parsed.textStyleNames) ||
      declaredAssets.length !== actualAssets.length || !declaredAssets.every((entry, index) => entry === actualAssets[index])) {
    throw new Error("コピー内容の参照情報が一致しません。");
  }
  return parsed;
}

/**
 * 複製・貼り付け・外部クライアントが共有する、ID と内部 HTML 参照の純粋な付け替え。
 * 外部 fragment への参照（fragment 外の href 等）は元のまま残す。
 */
export function normalizeNodeFragment(source: readonly PageNode[], destination: PageDocument): PageNode[] {
  const copies = structuredClone(source) as PageNode[], usedNodeIds = new Set(walkNodes(destination).flatMap(({ node }) => node.type === "text" ? [] : [node.id]));
  const usedHtmlIds = new Set(walkNodes(destination).flatMap(({ node }) => node.type === "element" && typeof node.attrs?.id === "string" ? [node.attrs.id] : []));
  const remap = new Map<string, string>();
  const rename = (node: PageNode): void => {
    if (node.type === "text") return;
    node.id = copyId(node.id, usedNodeIds);
    if (node.type === "element") {
      if (typeof node.attrs?.id === "string") {
        const previous = node.attrs.id;
        if (remap.has(previous)) throw new Error("部分木に重複する HTML ID があるため、複製できません。");
        node.attrs.id = copyId(previous, usedHtmlIds);
        remap.set(previous, node.attrs.id);
      }
      node.children.forEach(rename);
    }
  };
  copies.forEach(rename);
  const updateReferences = (node: PageNode): void => {
    if (node.type !== "element") return;
    if (typeof node.attrs?.href === "string" && node.attrs.href.startsWith("#") && remap.has(node.attrs.href.slice(1))) {
      node.attrs.href = `#${remap.get(node.attrs.href.slice(1))}`;
    }
    if (typeof node.attrs?.htmlFor === "string" && remap.has(node.attrs.htmlFor)) node.attrs.htmlFor = remap.get(node.attrs.htmlFor)!;
    for (const key of ["aria-labelledby", "aria-describedby"]) {
      const value = node.attrs?.[key];
      if (node.attrs && typeof value === "string") node.attrs[key] = value.split(/\s+/u).map((id) => remap.get(id) ?? id).join(" ");
    }
    node.children.forEach(updateReferences);
  };
  copies.forEach(updateReferences);
  return copies;
}
