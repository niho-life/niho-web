import type { PageDocument, PageNode } from "./types.js";

export type NodePath = readonly number[];
export type IndexedNode = Readonly<{ node: PageNode; path: NodePath }>;
type PageNodeIndex = { entries: readonly IndexedNode[]; byId: ReadonlyMap<string, readonly IndexedNode[]> };
const pageNodeIndexes = new WeakMap<PageDocument, PageNodeIndex>();

/** Immutable editor snapshots reuse one node/path index for stable-ID lookups and derived views. */
function pageNodeIndex(document: PageDocument): PageNodeIndex {
  const cached = pageNodeIndexes.get(document);
  if (cached) return cached;
  const entries: IndexedNode[] = [], mutableById = new Map<string, IndexedNode[]>();
  function visit(nodes: readonly PageNode[], parent: NodePath): void {
    nodes.forEach((node, index) => {
      const path = Object.freeze([...parent, index]);
      const entry = Object.freeze({ node, path });
      entries.push(entry);
      if (node.type !== "text") {
        const matches = mutableById.get(node.id) ?? [];
        matches.push(entry);
        mutableById.set(node.id, matches);
      }
      if (node.type === "element") visit(node.children, path);
    });
  }
  visit(document.body, []);
  const index = { entries: Object.freeze(entries), byId: new Map([...mutableById].map(([id, matches]) => [id, Object.freeze(matches)])) };
  pageNodeIndexes.set(document, index);
  return index;
}

/** Cached preorder entries for a document that is treated as an immutable snapshot. */
export function indexedNodes(document: PageDocument): readonly IndexedNode[] {
  return pageNodeIndex(document).entries;
}

/** All paths for an ID, preserving duplicate detection for untrusted documents. */
export function indexedNodesById(document: PageDocument, id: string): readonly IndexedNode[] {
  return pageNodeIndex(document).byId.get(id) ?? [];
}

export function nodeAt(document: PageDocument, path: NodePath): PageNode {
  if (!path.length) throw new Error("要素を選択してください。");
  let children = document.body, result: PageNode | undefined;
  for (const [level, index] of path.entries()) {
    if (!Number.isInteger(index) || index < 0 || !children[index]) throw new Error("選択した要素が見つかりません。");
    result = children[index]!;
    if (level < path.length - 1) {
      if (result.type !== "element") throw new Error("この要素は子を持てません。");
      children = result.children;
    }
  }
  return result!;
}
/** インスタンスは子を持たないため、部品の内側へは入らない。 */
export function walkNodes(document: PageDocument): { node: PageNode; path: number[] }[] {
  const result: { node: PageNode; path: number[] }[] = [];
  function visit(nodes: PageNode[], parent: number[]): void {
    nodes.forEach((node, index) => {
      const path = [...parent, index]; result.push({ node, path });
      if (node.type === "element") visit(node.children, path);
    });
  }
  visit(document.body, []); return result;
}
/** path のノードを含む配列。 */
export function siblingsAt(document: PageDocument, path: NodePath): PageNode[] {
  if (path.length === 1) return document.body;
  const parent = nodeAt(document, path.slice(0, -1));
  if (parent.type !== "element") throw new Error("移動先が要素ではありません。");
  return parent.children;
}
/** 使用済みの ID と重ならない `<ID>_copy<n>` を返し、使用済みへ加える。 */
export function copyId(original: string, used: Set<string>): string {
  let index = 1, id = original;
  do { id = `${original.slice(0, 65)}_copy${index++}`; } while (used.has(id));
  used.add(id); return id;
}
