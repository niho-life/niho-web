import type { PageDocument, PageNode } from "./types.js";

export type NodePath = readonly number[];
export type NodeDocumentIndex = {
  readonly entries: readonly { node: PageNode; path: number[] }[];
  readonly paths: ReadonlyMap<string, NodePath>;
  readonly duplicates: ReadonlySet<string>;
};
const documentIndexes = new WeakMap<PageDocument, NodeDocumentIndex>();
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
/** Immutable editor snapshots reuse one node traversal for selection paths, locks and render projections. */
export function indexNodeDocument(document: PageDocument): NodeDocumentIndex {
  const cached = documentIndexes.get(document);
  if (cached) return cached;
  const entries = walkNodes(document), paths = new Map<string, NodePath>(), duplicates = new Set<string>();
  for (const { node, path } of entries) {
    if (node.type === "text") continue;
    if (paths.has(node.id)) duplicates.add(node.id);
    else paths.set(node.id, Object.freeze([...path]));
  }
  const index = { entries, paths, duplicates };
  documentIndexes.set(document, index);
  return index;
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
