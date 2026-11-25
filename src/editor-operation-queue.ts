import { PAGE_OPERATION_LIMIT, pageOperationWire, parsePageOperation, type EditingPageApplied } from "./editing-page-operations.js";
import { editDocumentById, fingerprint, nodeAt, walkNodes, type EditorHistory, type EditorOperation, type EditorOperationById } from "./editor-model.js";
import { siblingsAt } from "./node-tree.js";
import type { EditorApplyOperationsRequest } from "./editor-types.js";
import type { PageDocument, PageNode, StateName, StyleProperty } from "./types.js";

export const PAGE_OPERATION_MAX_AGE_MS = 5 * 60 * 1000;
type Change = { forward: readonly EditorOperationById[]; inverse: readonly EditorOperationById[] };
type Apply = (document: PageDocument, operation: EditorOperationById) => PageDocument;
type Edit = (document: PageDocument, operation: EditorOperation) => PageDocument;

export type EditorOperationQueue = {
  base: PageDocument;
  pending: readonly EditorOperationById[];
  since?: number;
  past: readonly Change[];
  future: readonly Change[];
  fallback: boolean;
  inFlight?: { request: EditorApplyOperationsRequest; count: number; submitted: PageDocument };
};
export function operationQueue(base: PageDocument): EditorOperationQueue {
  return { base, pending: [], past: [], future: [], fallback: false };
}
export function fallbackOperations(queue: EditorOperationQueue): EditorOperationQueue {
  return { ...queue, fallback: true, past: [], future: [] };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}
const equivalent = (left: unknown, right: unknown) => canonical(left) === canonical(right);
export function replayOperations(document: PageDocument, operations: readonly EditorOperationById[], apply: Apply): PageDocument {
  return operations.reduce(apply, document);
}

function stableOperation(document: PageDocument, operation: EditorOperation): EditorOperationById {
  if (!("path" in operation)) return operation;
  const { path, ...change } = operation;
  if (change.type === "text") {
    const parent = path.length > 1 ? nodeAt(document, path.slice(0, -1)) : undefined;
    if (parent && parent.type !== "element") throw new Error("invalid text parent");
    return { ...change, parentId: parent?.id ?? null, childPath: path.slice(-1) };
  }
  const node = nodeAt(document, path);
  if (node.type === "text") throw new Error("operation requires a node ID");
  return { ...change, nodeId: node.id };
}

function textEdits(before: readonly PageNode[], after: readonly PageNode[], parentId: string): Change | undefined {
  if (before.length !== after.length) return undefined;
  const forward: EditorOperationById[] = [], inverse: EditorOperationById[] = [];
  for (const [index, previous] of before.entries()) {
    const next = after[index]!;
    if (previous.type === "text" && next.type === "text") {
      if (previous.text !== next.text) {
        forward.push({ type: "text", parentId, childPath: [index], value: next.text });
        inverse.push({ type: "text", parentId, childPath: [index], value: previous.text });
      }
    } else if (previous.type === "element" && next.type === "element" && previous.id === next.id) {
      const { children: oldChildren, ...oldNode } = previous, { children: newChildren, ...newNode } = next;
      if (!equivalent(oldNode, newNode)) return undefined;
      const nested = textEdits(oldChildren, newChildren, previous.id);
      if (!nested) return undefined;
      forward.push(...nested.forward); inverse.push(...nested.inverse);
    } else if (!equivalent(previous, next)) return undefined;
  }
  return { forward, inverse };
}

function inverseOperation(before: PageDocument, after: PageDocument, operation: EditorOperation, forward: EditorOperationById): readonly EditorOperationById[] | undefined {
  if (forward.type === "title") return [{ ...forward, value: before.title }];
  if (forward.type === "meta") return [{ ...forward, value: before.meta?.[forward.field] } as EditorOperationById];
  if (forward.type === "token") return [{ ...forward, token: before.tokens[forward.name] }];
  if (forward.type === "textStyle") return [{ ...forward, style: before.textStyles?.[forward.name] }];
  if (forward.type === "add" || forward.type === "addMany") {
    const nodes = forward.type === "add" ? [forward.node] : forward.nodes;
    if (nodes.some((node) => node.type === "text")) return undefined;
    const candidates = nodes.flatMap((node) => node.type === "text" ? [] : [node.id]), included = new Set(candidates), paired = new Set<string>();
    const locations = new Map(walkNodes(after).flatMap((entry) => entry.node.type === "text" ? [] : [[entry.node.id, entry] as const]));
    // remove はフォームの label/control ペアをまとめて削除するため、inverse も1回だけ削除する。
    for (const id of candidates) {
      const entry = locations.get(id);
      if (!entry) return undefined;
      const siblings = siblingsAt(after, entry.path), node = entry.node, index = entry.path.at(-1)!;
      const controlId = node.type === "element" && ["input", "textarea", "select"].includes(node.tag) ? node.attrs?.id : undefined;
      const labelTarget = node.type === "element" && node.tag === "label" ? node.attrs?.htmlFor : undefined;
      const pair = siblings.find((candidate, at) => at !== index && included.has(candidate.type === "text" ? "" : candidate.id) && candidate.type === "element" &&
        (typeof controlId === "string" && candidate.tag === "label" && candidate.attrs?.htmlFor === controlId ||
         typeof labelTarget === "string" && ["input", "textarea", "select"].includes(candidate.tag) && candidate.attrs?.id === labelTarget));
      if (pair && pair.type !== "text" && index < siblings.indexOf(pair)) paired.add(pair.id);
    }
    return candidates.filter((id) => !paired.has(id)).map((nodeId) => ({ type: "remove", nodeId }));
  }
  if (!("path" in operation)) return undefined;
  const node = nodeAt(before, operation.path);
  if (forward.type === "text") return node.type === "text" ? [{ ...forward, value: node.text }] : undefined;
  if (node.type === "text") return undefined;
  if (forward.type === "duplicate") {
    const oldIds = new Set(siblingsAt(before, operation.path).flatMap((sibling) => sibling.type === "text" ? [] : [sibling.id]));
    const copies = siblingsAt(after, operation.path).flatMap((sibling) => sibling.type !== "text" && !oldIds.has(sibling.id) ? [sibling.id] : []);
    // One remove also removes a paired form control or label. Verify the preimage below.
    return copies.length ? [{ type: "remove", nodeId: copies[0]! }] : undefined;
  }
  if (forward.type === "remove" || forward.type === "move") {
    const path = operation.path, parent = path.length > 1 ? nodeAt(before, path.slice(0, -1)) : undefined;
    if (parent && parent.type !== "element") return undefined;
    const location = { parentId: parent?.id ?? null, index: path.at(-1)! };
    if (forward.type === "move") return [{ ...forward, ...location }];
    const kept = new Set(siblingsAt(after, path).flatMap((sibling) => sibling.type === "text" ? [] : [sibling.id]));
    const removed = siblingsAt(before, path).flatMap((sibling, at) => sibling.type !== "text" && !kept.has(sibling.id) ? [{ sibling, at }] : []);
    if (removed.length === 1) return [{ type: "add", node, ...location }];
    if (removed.length === 2 && removed[1]!.at === removed[0]!.at + 1) return [{ type: "addMany", nodes: removed.map(({ sibling }) => sibling), parentId: location.parentId, index: removed[0]!.at }];
    return undefined;
  }
  if (forward.type === "style" || forward.type === "styles" || forward.type === "styleRange" || forward.type === "resize" || forward.type === "slotStyle" || forward.type === "background") {
    const style = forward.type === "slotStyle" && node.type === "component" ? node.slots?.[forward.slot] : node.style;
    const previous = forward.breakpoint === "base" ? style?.base : style?.responsive?.find(({ minWidth }) => minWidth === forward.breakpoint)?.declarations;
    if (forward.type === "style" || forward.type === "slotStyle") return [{ ...forward, value: previous?.[forward.property] }];
    if (forward.type === "background") {
      const background = previous?.backgroundImage;
      return background === "none" ? undefined : [{ ...forward, asset: background?.asset }];
    }
    const properties: readonly StyleProperty[] = forward.type === "resize" ? ["width", "height"] : Object.keys(forward.values) as StyleProperty[];
    const values = Object.fromEntries(properties.map((name) => [name, previous?.[name]]));
    const inverse: EditorOperationById[] = [{ type: "styles", nodeId: node.id, breakpoint: forward.breakpoint, values }];
    if ("until" in forward && forward.until !== undefined) {
      const next = nodeAt(after, operation.path);
      if (next.type === "text") return undefined;
      const width = forward.until;
      const original = style?.responsive?.find(({ minWidth }) => minWidth === width)?.declarations;
      const updated = next.style?.responsive?.find(({ minWidth }) => minWidth === width)?.declarations;
      const changed = Object.keys(updated ?? {}).filter((name) => name !== "backgroundImage" && !equivalent(updated?.[name as StyleProperty], original?.[name as StyleProperty]));
      if (changed.length) inverse.push({ type: "styles", nodeId: node.id, breakpoint: width, values: Object.fromEntries(changed.map((name) => [name, original?.[name as StyleProperty]])) });
    }
    return inverse;
  }
  if (forward.type === "state") {
    const states = new Set<StateName>([forward.state, ...forward.also ?? []]);
    return [...states].map((state) => ({
      type: "state", nodeId: node.id, state,
      values: Object.fromEntries((Object.keys(forward.values) as Array<keyof typeof forward.values>).map((name) => [name, node.style?.states?.[state]?.[name]]))
    }));
  }
  if (forward.type === "appear") return [{ ...forward, value: node.style?.appear }];
  if (forward.type === "hidden") return [{ ...forward, ranges: node.style?.hidden }];
  if (forward.type === "nodeTextStyle") return [{ type: "nodeTextStyle", nodeId: node.id, name: node.style?.textStyle }];
  if (forward.type === "prop" && node.type === "component") return [{ ...forward, value: node.props[forward.name] }];
  if (forward.type === "instanceProp" && node.type === "instance") return [{ ...forward, value: node.props?.[forward.name] }];
  if (node.type !== "element") return undefined;
  switch (forward.type) {
    case "attribute": return [{ ...forward, value: String(node.attrs?.[forward.name] ?? "") }];
    case "booleanAttribute": return [{ ...forward, value: node.attrs?.[forward.name] === true }];
    case "formCompletionPage": return [{ ...forward, pageId: node.formCompletionPageId }];
    case "tag": return [{ ...forward, value: node.tag as typeof forward.value }];
    case "icon": return node.icon ? [{ ...forward, name: node.icon }] : undefined;
    case "embedSource": return [{ ...forward, source: node.embed?.source ?? "" }];
    case "embedTitle": return node.embed ? [{ ...forward, title: node.embed.title }] : undefined;
    case "loopBox": return node.interaction?.type === "loop-box" ? [{ ...forward, speed: node.interaction.speed, pauseOnHover: node.interaction.pauseOnHover }] : undefined;
    case "image": return [{ ...forward, source: node.asset ? { asset: node.asset } : { src: String(node.attrs?.src ?? ""), ...(typeof node.attrs?.srcSet === "string" ? { srcset: node.attrs.srcSet } : {}) }, ...(typeof node.attrs?.alt === "string" ? { alt: node.attrs.alt } : {}) }];
    case "video": return [{ ...forward, source: node.asset ? { asset: node.asset } : { src: String(node.attrs?.src ?? "") } }];
    default: return undefined;
  }
}

function reversibleChange(before: PageDocument, after: PageDocument, operation: EditorOperation, apply: Apply): Change | undefined {
  let change: Change | undefined;
  if (operation.type === "replaceChildren") {
    const old = nodeAt(before, operation.path), next = nodeAt(after, operation.path);
    if (old.type === "element" && next.type === "element") change = textEdits(old.children, next.children, old.id);
  } else {
    const forward = stableOperation(before, operation), inverse = inverseOperation(before, after, operation, forward);
    if (inverse) change = { forward: [forward], inverse };
  }
  if (!change) return undefined;
  const canonical = (entry: EditorOperationById) => parsePageOperation(JSON.parse(JSON.stringify(pageOperationWire(entry))), "$operation");
  const forward = change.forward.map(canonical), inverse = change.inverse.map(canonical);
  if (equivalent(replayOperations(before, forward, apply), after) && equivalent(replayOperations(after, inverse, apply), before)) return { forward, inverse };
  return undefined;
}

function enqueue(queue: EditorOperationQueue, operations: readonly EditorOperationById[]): EditorOperationQueue {
  const pending = [...queue.pending, ...operations];
  return pending.length > PAGE_OPERATION_LIMIT ? fallbackOperations(queue) : { ...queue, pending, since: queue.since ?? Date.now() };
}

export function queuePageEdit(queue: EditorOperationQueue, document: PageDocument, operations: readonly EditorOperation[], edit: Edit, apply: Apply): { document: PageDocument; queue: EditorOperationQueue } {
  const forward: EditorOperationById[] = [], inverse: EditorOperationById[] = [];
  for (const operation of operations) {
    const next = edit(document, operation);
    if (!queue.fallback && fingerprint(document) !== fingerprint(next)) {
      let change: Change | undefined;
      try { change = reversibleChange(document, next, operation, apply); } catch { /* The full-document save can preserve this valid local edit. */ }
      if (change) { forward.push(...change.forward); inverse.unshift(...change.inverse); }
      else queue = fallbackOperations(queue);
    }
    document = next;
  }
  if (!queue.fallback && forward.length) queue = enqueue({ ...queue, past: [...queue.past.slice(-49), { forward, inverse }], future: [] }, forward);
  return { document, queue };
}
export function queuePageTravel(queue: EditorOperationQueue, before: PageDocument, after: PageDocument, direction: "undo" | "redo", apply: Apply): EditorOperationQueue {
  if (queue.fallback || before === after) return queue;
  const change = direction === "undo" ? queue.past.at(-1) : queue.future[0];
  if (!change) return fallbackOperations(queue);
  try {
    const operations = direction === "undo" ? change.inverse : change.forward;
    if (!equivalent(replayOperations(before, operations, apply), after)) return fallbackOperations(queue);
    const history = direction === "undo" ? { past: queue.past.slice(0, -1), future: [change, ...queue.future] } : { past: [...queue.past, change], future: queue.future.slice(1) };
    return enqueue({ ...queue, ...history }, operations);
  } catch { return fallbackOperations(queue); }
}

export function canSendOperations(queue: EditorOperationQueue, document: PageDocument, apply: Apply): boolean {
  if (queue.fallback || !queue.pending.length || Date.now() - (queue.since ?? 0) >= PAGE_OPERATION_MAX_AGE_MS) return false;
  try { return equivalent(replayOperations(queue.base, queue.pending, apply), document); }
  catch { return false; }
}

function followCanonicalHistory(queue: EditorOperationQueue, present: PageDocument, apply: Apply) {
  const past: PageDocument[] = [], future: PageDocument[] = [];
  const unwind = (changes: readonly Change[], direction: "inverse" | "forward", documents: PageDocument[]) => {
    let current = present;
    for (const change of changes) {
      try { current = replayOperations(current, change[direction], apply); }
      catch { break; }
      documents.push(current);
    }
  };
  unwind([...queue.past].reverse(), "inverse", past);
  unwind(queue.future, "forward", future);
  return {
    queue: { ...queue, past: queue.past.slice(queue.past.length - past.length), future: queue.future.slice(0, future.length) },
    history: { past: past.reverse(), present, future },
  };
}

export function acceptAppliedOperations(queue: EditorOperationQueue, result: EditingPageApplied, history: EditorHistory, apply: Apply): { queue: EditorOperationQueue; history: EditorHistory; replayFailed: boolean } {
  if (!queue.inFlight) throw new Error("操作の保存要求が見つかりません。");
  const pending = queue.pending.slice(queue.inFlight.count);
  const next: EditorOperationQueue = { ...queue, base: result.document, pending };
  delete next.inFlight;
  if (!pending.length) delete next.since;
  const revise = (document: PageDocument) => ({ ...document, revision: result.revision });
  const revised = { past: history.past.map(revise), present: revise(history.present), future: history.future.map(revise) };
  try {
    const canonical = replayChecked(queue.inFlight.submitted, result.document, history.present, pending, apply);
    if (!canonical) throw new Error("保留中の編集を再適用できません。");
    if (!queue.fallback && !equivalent(revise(queue.inFlight.submitted), result.document)) return { ...followCanonicalHistory(next, canonical, apply), replayFailed: false };
    return { queue: next, history: { ...revised, present: canonical }, replayFailed: false };
  } catch { return { queue: fallbackOperations(next), history: revised, replayFailed: true }; }
}

/** A text path may still resolve to the wrong text after a structural edit. Require its owning sequence to match. */
function operationAnchor(document: PageDocument, operation: EditorOperationById): unknown {
  const find = (id: string) => walkNodes(document).find(({ node }) => node.type !== "text" && node.id === id)?.node;
  const siblings = (id: string | null) => {
    const owner = id === null ? undefined : find(id);
    return id === null ? document.body : owner?.type === "element" ? owner.children : undefined;
  };
  switch (operation.type) {
    case "text": return siblings(operation.parentId);
    case "add": case "addMany": return siblings(operation.parentId);
    case "duplicate": case "remove": case "move": {
      const located = walkNodes(document).find(({ node }) => node.type !== "text" && node.id === operation.nodeId);
      const source = located ? siblingsAt(document, located.path) : undefined;
      return operation.type === "move" ? [source, siblings(operation.parentId)] : source;
    }
    case "title": return document.title;
    case "meta": return document.meta?.[operation.field];
    case "token": return document.tokens[operation.name];
    case "textStyle": return document.textStyles?.[operation.name];
    default: return "nodeId" in operation ? find(operation.nodeId) : document;
  }
}
function replayChecked(before: PageDocument, present: PageDocument, local: PageDocument, operations: readonly EditorOperationById[], apply: Apply): PageDocument | undefined {
  for (const operation of operations) {
    if (!equivalent(operationAnchor(before, operation), operationAnchor(present, operation))) return undefined;
    before = apply(before, operation);
    present = apply(present, operation);
  }
  return equivalent(before, local) ? present : undefined;
}

export function reviewOperationConflict(queue: EditorOperationQueue, latest: PageDocument, local: PageDocument, apply: Apply): { queue: EditorOperationQueue; history: EditorHistory } | undefined {
  if (queue.fallback || !queue.pending.length) return undefined;
  try {
    const present = replayChecked(queue.base, latest, local, queue.pending, apply);
    if (!present) return undefined;
    const refreshed = operationQueue(latest);
    // Treat the confirmed group as a single edit based on the concurrent author's document.
    return { queue: { ...refreshed, pending: queue.pending, since: Date.now() }, history: { past: [latest], present, future: [] } };
  } catch { return undefined; }
}

export function operationApplier(blocks: Parameters<typeof editDocumentById>[2], locks: Parameters<typeof editDocumentById>[3], components: Parameters<typeof editDocumentById>[4], siteStyles: Parameters<typeof editDocumentById>[5]): Apply {
  return (document, operation) => editDocumentById(document, operation, blocks, locks, components, siteStyles);
}
