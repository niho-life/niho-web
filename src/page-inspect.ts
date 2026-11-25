import { expandDocument } from "./component-expand.js";
import { resolvePageStyles, type SiteStyles } from "./site-styles.js";
import type {
  ComponentLibrary, DesignToken, ElementNode, PageDocument, PageNode, StateName, StyleDeclarations, StyleProperty
} from "./types.js";

export const PAGE_INSPECT_LIMITS = Object.freeze({
  maxItems: 1000,
  defaultItems: 1000,
  maxResultBytes: 240 * 1024,
  maxCursorLength: 2048,
  excerptLength: 40
});

export type PageInspectView = "outline" | "find" | "subtree" | "effectiveStyle";
export type PageInspectQuery = {
  readonly view: PageInspectView;
  readonly node?: string;
  readonly depth?: number;
  readonly text?: string;
  readonly name?: string;
  readonly tag?: string;
  readonly style?: string;
  readonly usesToken?: string;
  readonly block?: string;
  readonly limit?: number;
  readonly cursor?: string;
};
export type PageInspectContext = { readonly siteStyles?: SiteStyles; readonly components?: ComponentLibrary };
export class PageInspectError extends Error {
  constructor(readonly code: "invalid_request" | "invalid_cursor" | "node_not_found" | "result_too_large") {
    super(code);
  }
}

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u;
const TAGS = new Set([
  "div", "section", "article", "header", "footer", "main", "nav", "aside", "h1", "h2", "h3", "h4", "h5", "h6", "p", "span",
  "a", "img", "picture", "source", "video", "ul", "ol", "li", "dl", "dt", "dd", "strong", "em", "b", "i", "small",
  "blockquote", "figure", "figcaption", "br", "hr", "time", "details", "summary", "form", "label", "input", "textarea", "select", "option", "button", "fieldset", "legend"
]);
const STATES: readonly StateName[] = ["hover", "focus", "active"];
const LAYOUT_PROPERTIES: readonly StyleProperty[] = ["display", "flexDirection", "flexWrap", "justifyContent", "alignItems", "alignContent", "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight", "gap", "rowGap", "columnGap", "gridTemplateColumns", "gridTemplateRows", "position"];
const INHERITED_PROPERTIES = new Set<StyleProperty>([
  "color", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "wordSpacing", "fontVariantEastAsian",
  "textAlign", "fontStyle", "textDecorationLine", "writingMode"
]);

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function safeText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** URL の query を閉じた投影入力へ変換する。重複・未知 field は拒否する。 */
export function parsePageInspectQuery(value: unknown): PageInspectQuery | null {
  if (!plainRecord(value) || typeof value.view !== "string" || !["outline", "find", "subtree", "effectiveStyle"].includes(value.view)) return null;
  const view = value.view as PageInspectView;
  const common = ["view", "limit", "cursor"];
  const fields = view === "outline" ? [...common, "node", "depth"]
    : view === "find" ? [...common, "text", "name", "tag", "style", "usesToken", "block", "node"]
      : [...common, "node"];
  if (!exactKeys(value, fields)) return null;
  const limit = value.limit === undefined ? PAGE_INSPECT_LIMITS.defaultItems
    : typeof value.limit === "number" ? value.limit
      : typeof value.limit === "string" && /^\d{1,4}$/u.test(value.limit) ? Number(value.limit) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_INSPECT_LIMITS.maxItems
    || value.cursor !== undefined && (!safeText(value.cursor, PAGE_INSPECT_LIMITS.maxCursorLength) || !/^[A-Za-z0-9_-]+$/u.test(value.cursor))) return null;
  const result: PageInspectQuery = { view, limit, ...(value.cursor === undefined ? {} : { cursor: value.cursor as string }) };
  if (view === "outline") {
    if (value.node !== undefined && (!safeText(value.node, 80) || !ID.test(value.node))
      || value.depth !== undefined && (typeof value.depth !== "number" && !(typeof value.depth === "string" && /^\d{1,2}$/u.test(value.depth))
        || !Number.isSafeInteger(Number(value.depth)) || Number(value.depth) < 0 || Number(value.depth) > 10)) return null;
    return { ...result, ...(typeof value.node === "string" ? { node: value.node } : {}),
      ...(value.depth === undefined ? {} : { depth: Number(value.depth) }) };
  }
  if (view === "find") {
    if (["text", "name", "tag", "style", "usesToken", "block", "node"].some((key) => value[key] !== undefined && typeof value[key] !== "string")) return null;
    if (value.text !== undefined && !safeText(value.text, 200)
      || value.name !== undefined && (!safeText(value.name, 240) || [...value.name].length > 120)
      || value.tag !== undefined && (typeof value.tag !== "string" || !TAGS.has(value.tag))
      || value.usesToken !== undefined && (typeof value.usesToken !== "string" || !ID.test(value.usesToken))
      || value.block !== undefined && (typeof value.block !== "string" || !ID.test(value.block))
      || value.node !== undefined && (typeof value.node !== "string" || !ID.test(value.node))) return null;
    if (value.style !== undefined && (typeof value.style !== "string" || value.style.length > 240 || !/^[A-Za-z][A-Za-z0-9]*=.{1,200}$/u.test(value.style))) return null;
    if (!["text", "name", "tag", "style", "usesToken", "block", "node"].some((key) => value[key] !== undefined)) return null;
    return { ...result,
      ...(typeof value.text === "string" ? { text: value.text } : {}), ...(typeof value.name === "string" ? { name: value.name } : {}),
      ...(typeof value.tag === "string" ? { tag: value.tag } : {}), ...(typeof value.style === "string" ? { style: value.style } : {}),
      ...(typeof value.usesToken === "string" ? { usesToken: value.usesToken } : {}), ...(typeof value.block === "string" ? { block: value.block } : {}),
      ...(typeof value.node === "string" ? { node: value.node } : {}) };
  }
  if (typeof value.node !== "string" || !ID.test(value.node)) return null;
  return { ...result, node: value.node };
}

type Entry = { readonly id: string; readonly path: readonly number[]; readonly node: Exclude<PageNode, { type: "text" }>; readonly parentNames: readonly string[] };
type ComponentOrigin = { instance: string; component: string; node: string; chain: readonly string[] };
type WalkContext = { document: PageDocument; rawDocument: PageDocument; origins: Map<string, ComponentOrigin>; library?: ComponentLibrary; siteStyles?: SiteStyles };
function componentRoot(node: PageNode, library?: ComponentLibrary, origins?: ReadonlyMap<string, ComponentOrigin>): ComponentLibrary["components"][number] | undefined {
  if (node.type === "text") return undefined;
  const origin = origins?.get(node.id);
  const definition = origin && library?.components.find((component) => component.id === origin.component);
  return definition && origin.node === definition.root.id ? definition : undefined;
}
function displayName(node: PageNode, library?: ComponentLibrary, origins?: ReadonlyMap<string, ComponentOrigin>): string | undefined {
  if (node.type !== "text" && node.name !== undefined) return node.name;
  const expandedComponent = componentRoot(node, library, origins);
  if (expandedComponent) return expandedComponent.name;
  if (node.type === "instance") return library?.components.find((component) => component.id === node.component)?.name;
  return undefined;
}
function nodeLabel(node: PageNode, library?: ComponentLibrary, origins?: ReadonlyMap<string, ComponentOrigin>): string {
  return displayName(node, library, origins) ?? (node.type === "element" ? node.tag : node.type === "component" ? node.block : node.type === "instance" ? node.component : node.type);
}
function prepare(document: PageDocument, context: PageInspectContext): WalkContext {
  if (!context.components) return { document: resolvePageStyles(document, context.siteStyles), rawDocument: document, origins: new Map(),
    ...(context.siteStyles ? { siteStyles: context.siteStyles } : {}) };
  const expanded = expandDocument(document, context.components);
  return { document: resolvePageStyles(expanded.document, context.siteStyles), rawDocument: document, origins: expanded.origins,
    library: context.components, ...(context.siteStyles ? { siteStyles: context.siteStyles } : {}) };
}
function walkNodes(document: PageDocument, visit: (node: PageNode, path: number[], parents: PageNode[]) => void): void {
  const walk = (nodes: readonly PageNode[], parentPath: number[], parents: PageNode[]): void => {
    nodes.forEach((node, index) => {
      const path = [...parentPath, index];
      visit(node, path, parents);
      if (node.type === "element") walk(node.children, path, [...parents, node]);
    });
  };
  walk(document.body, [], []);
}
function nodeEntries(document: PageDocument, library?: ComponentLibrary, origins?: ReadonlyMap<string, ComponentOrigin>): Entry[] {
  const entries: Entry[] = [];
  walkNodes(document, (node, path, parents) => {
    if (node.type === "text") return;
    entries.push({ id: node.id, path, node, parentNames: parents.map((parent) => nodeLabel(parent, library, origins)) });
  });
  return entries;
}
function textOf(node: PageNode): string {
  if (node.type === "text") return node.text;
  return node.type === "element" ? node.children.map(textOf).join("") : "";
}
function excerpt(value: string): string {
  const chars = [...value];
  return chars.length > PAGE_INSPECT_LIMITS.excerptLength ? chars.slice(0, PAGE_INSPECT_LIMITS.excerptLength).join("") : value;
}
function tokenReferences(value: unknown, result = new Set<string>()): string[] {
  if (Array.isArray(value)) for (const item of value) tokenReferences(item, result);
  else if (plainRecord(value)) {
    if (typeof value.token === "string" && Object.keys(value).length === 1) result.add(value.token);
    else for (const item of Object.values(value)) tokenReferences(item, result);
  }
  return [...result].sort();
}
function responsiveWidths(value: unknown, result = new Set<number>()): number[] {
  if (Array.isArray(value)) for (const item of value) responsiveWidths(item, result);
  else if (plainRecord(value)) {
    if (typeof value.minWidth === "number" && Number.isSafeInteger(value.minWidth)) result.add(value.minWidth);
    for (const item of Object.values(value)) responsiveWidths(item, result);
  }
  return [...result].sort((a, b) => a - b);
}
function textStyleFor(node: Exclude<PageNode, { type: "text" }>, document: PageDocument): unknown {
  const name = node.style?.textStyle;
  return name ? document.textStyles?.[name] : undefined;
}
function outlineRow(entry: Entry, document: PageDocument, library?: ComponentLibrary, origins?: ReadonlyMap<string, ComponentOrigin>): Record<string, unknown> {
  const { node } = entry;
  const text = excerpt(textOf(node));
  const style = node.style;
  const layout = style?.base && Object.fromEntries(Object.entries(style.base).filter(([key]) => LAYOUT_PROPERTIES.includes(key as StyleProperty)));
  const tokens = new Set(tokenReferences(style));
  for (const name of tokenReferences(textStyleFor(node, document))) tokens.add(name);
  const responsive = style?.responsive?.length ?? 0;
  const states = style?.states ? Object.values(style.states).reduce((sum, state) => sum + Object.keys(state ?? {}).length, 0) : 0;
  const name = displayName(node, library, origins), expandedComponent = componentRoot(node, library, origins);
  return {
    id: node.id, type: node.type, ...(name ? { name } : {}),
    ...(node.type === "element" ? { tag: node.tag, ...(expandedComponent ? { component: expandedComponent.id } : {}) }
      : node.type === "component" ? { block: node.block } : node.type === "instance" ? { component: node.component } : {}),
    ...(text ? { text } : {}), ...(layout && Object.keys(layout).length ? { layout } : {}),
    ...(tokens.size ? { tokens: [...tokens].sort() } : {}), overrides: responsive + states
  };
}
function findStyleMatch(entry: Entry, document: PageDocument, property: string, expected: string): boolean {
  const values: unknown[] = [];
  const style = entry.node.style;
  if (style?.base && Object.hasOwn(style.base, property)) values.push(style.base[property as keyof StyleDeclarations]);
  for (const tier of style?.responsive ?? []) if (Object.hasOwn(tier.declarations, property)) values.push(tier.declarations[property as keyof StyleDeclarations]);
  for (const state of Object.values(style?.states ?? {})) if (state && Object.hasOwn(state, property)) values.push(state[property as keyof typeof state]);
  const textStyle = textStyleFor(entry.node, document);
  if (plainRecord(textStyle)) {
    if (plainRecord(textStyle.base) && Object.hasOwn(textStyle.base, property)) values.push(textStyle.base[property]);
    if (Array.isArray(textStyle.responsive)) for (const tier of textStyle.responsive) {
      if (plainRecord(tier) && plainRecord(tier.declarations) && Object.hasOwn(tier.declarations, property)) values.push(tier.declarations[property]);
    }
  }
  const tokens = document.tokens as Record<string, DesignToken>;
  return values.some((value) => {
    if (JSON.stringify(value) === JSON.stringify(expected)) return true;
    if (plainRecord(value) && typeof value.token === "string") return String(tokens[value.token]?.value) === expected || ("$" + value.token) === expected;
    return String(value) === expected;
  });
}
function queryMatches(entry: Entry, query: PageInspectQuery, document: PageDocument, library?: ComponentLibrary, origins?: ReadonlyMap<string, ComponentOrigin>): boolean {
  const node = entry.node;
  if (query.node !== undefined && node.id !== query.node) return false;
  if (query.tag !== undefined && (node.type !== "element" || node.tag !== query.tag)) return false;
  if (query.name !== undefined && displayName(node, library, origins) !== query.name) return false;
  if (query.text !== undefined && !textOf(node).toLocaleLowerCase().includes(query.text.toLocaleLowerCase())) return false;
  if (query.block !== undefined && !((node.type === "component" && node.block === query.block) || (node.type === "instance" && node.component === query.block)
    || componentRoot(node, library, origins)?.id === query.block)) return false;
  if (query.usesToken !== undefined) {
    const refs = new Set([...tokenReferences(node.style), ...tokenReferences(textStyleFor(node, document))]);
    if (!refs.has(query.usesToken)) return false;
  }
  if (query.style !== undefined) {
    const split = query.style.indexOf("=");
    if (!findStyleMatch(entry, document, query.style.slice(0, split), query.style.slice(split + 1))) return false;
  }
  return true;
}
function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function queryHash(query: PageInspectQuery): string {
  const { cursor: _cursor, limit: _limit, ...rest } = query;
  return stableHash(JSON.stringify(rest));
}
function encodeCursor(payload: { document: string; query: string; offset: number }): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, ...payload }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function decodeCursor(cursor: string, document: string, query: string): number {
  try {
    const binary = atob(cursor.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - cursor.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!plainRecord(value) || Object.keys(value).sort().join(",") !== "document,offset,query,v" || value.v !== 1
      || value.document !== document || value.query !== query || !Number.isSafeInteger(value.offset) || (value.offset as number) < 0) throw new Error("invalid cursor");
    return value.offset as number;
  } catch { throw new PageInspectError("invalid_cursor"); }
}
function paginate<T>(items: readonly T[], query: PageInspectQuery, documentFingerprint: string, prefix: Record<string, unknown>): Record<string, unknown> {
  const queryFingerprint = queryHash(query), start = query.cursor === undefined ? 0 : decodeCursor(query.cursor, documentFingerprint, queryFingerprint);
  if (start > items.length) throw new PageInspectError("invalid_cursor");
  let end = Math.min(items.length, start + (query.limit ?? PAGE_INSPECT_LIMITS.defaultItems));
  for (;;) {
    const nextCursor = end < items.length ? encodeCursor({ document: documentFingerprint, query: queryFingerprint, offset: end }) : undefined;
    const result = { ...prefix, items: items.slice(start, end), ...(nextCursor ? { nextCursor } : {}) };
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength <= PAGE_INSPECT_LIMITS.maxResultBytes) {
      if (end === start && start < items.length) throw new PageInspectError("result_too_large");
      return result;
    }
    if (end <= start) throw new PageInspectError("result_too_large");
    end--;
  }
}
function selectedEntry(entries: readonly Entry[], id: string): Entry {
  const match = entries.filter((entry) => entry.id === id);
  if (match.length !== 1) throw new PageInspectError("node_not_found");
  return match[0]!;
}
function atPath(document: PageDocument, path: readonly number[]): PageNode {
  let current: PageNode[] = document.body;
  let node: PageNode | undefined;
  for (const index of path) {
    node = current[index];
    if (!node) throw new PageInspectError("node_not_found");
    current = node.type === "element" ? node.children : [];
  }
  if (!node) throw new PageInspectError("node_not_found");
  return node;
}
function subtreeEntries(root: PageNode): Array<{ path: number[]; node: PageNode }> {
  const result: Array<{ path: number[]; node: PageNode }> = [];
  const visit = (node: PageNode, path: number[]): void => {
    result.push({ path, node: node.type === "element" ? { ...node, children: [] } : structuredClone(node) });
    if (node.type === "element") node.children.forEach((child, index) => visit(child, [...path, index]));
  };
  visit(root, []);
  return result;
}
function sourceForStyle(
  context: WalkContext, entry: Entry, property: string, breakpoint: number | "base", state: StateName | undefined
): "page" | "siteShared" | "component" {
  const origin = context.origins.get(entry.id);
  if (origin && context.library) {
    const definition = context.library.components.find((item) => item.id === origin.component);
    if (definition) {
      const original = new Map<string, ElementNode>();
      const collect = (node: PageNode): void => {
        if (node.type !== "element") return;
        original.set(node.id, node);
        node.children.forEach(collect);
      };
      collect(definition.root);
      const sourceNode = original.get(origin.node);
      const sourceStyle = sourceNode?.style;
      if (origin.node === definition.root.id) {
        const instance = nodeEntries(context.rawDocument).find((item) => item.id === origin.instance)?.node;
        const overlay = instance?.type === "instance" ? instance.style : undefined;
        const overlayBlock = state ? overlay?.states?.[state] : breakpoint === "base" ? overlay?.base
          : overlay?.responsive?.find((item) => item.minWidth === breakpoint)?.declarations;
        if (overlayBlock && Object.hasOwn(overlayBlock, property)) return "page";
      }
      const sourceBlock = state ? sourceStyle?.states?.[state] : breakpoint === "base" ? sourceStyle?.base
        : sourceStyle?.responsive?.find((item) => item.minWidth === breakpoint)?.declarations;
      if (sourceBlock && Object.hasOwn(sourceBlock, property)) return "component";
      return "component";
    }
  }
  return "page";
}
function resolvedStyleValue(value: unknown, context: WalkContext): Record<string, unknown> {
  if (plainRecord(value) && typeof value.token === "string" && Object.keys(value).length === 1) {
    const pageToken = context.rawDocument.tokens[value.token], sharedToken = context.siteStyles?.tokens?.[value.token];
    const componentToken = context.library?.tokens[value.token];
    const resolved = context.document.tokens[value.token];
    return { value: resolved?.value ?? null, token: value.token,
      tokenSource: pageToken ? "page" : sharedToken ? "siteShared" : componentToken ? "component" : "missing" };
  }
  return { value };
}
function effectiveStyle(context: WalkContext, entry: Entry, entries: readonly Entry[]): Record<string, unknown> {
  const ancestorEntries = entries.filter((candidate) => candidate.path.length < entry.path.length
    && candidate.path.every((part, index) => part === entry.path[index]));
  const allEntries = [...ancestorEntries, entry];
  const widths = new Set<number>([0]);
  const properties = new Set<StyleProperty>();
  for (const current of allEntries) {
    const node = current.node;
    const style = node.style;
    for (const [property, value] of Object.entries(style?.base ?? {})) { properties.add(property as StyleProperty); void value; }
    for (const tier of style?.responsive ?? []) { widths.add(tier.minWidth); for (const property of Object.keys(tier.declarations)) properties.add(property as StyleProperty); }
    for (const state of Object.values(style?.states ?? {})) if (state) for (const property of Object.keys(state)) properties.add(property as StyleProperty);
    const name = style?.textStyle;
      const textStyle = name ? context.document.textStyles?.[name] : undefined;
    if (textStyle) {
      for (const property of Object.keys(textStyle.base)) properties.add(property as StyleProperty);
      for (const tier of textStyle.responsive ?? []) { widths.add(tier.minWidth); for (const property of Object.keys(tier.declarations)) properties.add(property as StyleProperty); }
    }
  }
  const declaration = (current: Entry, width: number, state?: StateName): Map<StyleProperty, { value: unknown; source: "page" | "siteShared" | "component" | "inherited" }> => {
    const node = current.node;
    const values = new Map<StyleProperty, { value: unknown; source: "page" | "siteShared" | "component" }>();
    const name = node.style?.textStyle;
    if (name) {
      const textStyle = context.document.textStyles?.[name] ?? context.siteStyles?.textStyles?.[name];
      if (textStyle) {
        const source = Object.hasOwn(context.rawDocument.textStyles ?? {}, name) ? "page" : "siteShared";
        for (const [property, value] of Object.entries(textStyle.base)) values.set(property as StyleProperty, { value, source });
        for (const tier of textStyle.responsive ?? []) if (tier.minWidth <= width) for (const [property, value] of Object.entries(tier.declarations)) values.set(property as StyleProperty, { value, source });
      }
    }
    const style = node.style;
    const apply = (valuesToApply: StyleDeclarations | undefined, breakpoint: number | "base", stateName?: StateName): void => {
      if (!valuesToApply) return;
      for (const [property, value] of Object.entries(valuesToApply)) {
        values.set(property as StyleProperty, { value, source: sourceForStyle(context, current, property, breakpoint, stateName) });
      }
    };
    apply(style?.base, "base");
    for (const tier of style?.responsive ?? []) if (tier.minWidth <= width) apply(tier.declarations, tier.minWidth);
    if (state) apply(style?.states?.[state], "base", state);
    return values;
  };
  const variants: Array<Record<string, unknown>> = [];
  const orderedWidths = [...widths].sort((a, b) => a - b);
  for (const width of orderedWidths) for (const state of [undefined, ...STATES] as const) {
    const values: Record<string, unknown> = {};
    const self = declaration(entry, width, state);
    const parentMaps = ancestorEntries.map((ancestor) => declaration(ancestor, width, state));
    for (const property of [...properties].sort()) {
      let selected = self.get(property);
      if (!selected && INHERITED_PROPERTIES.has(property)) {
        for (let index = parentMaps.length - 1; index >= 0; index--) {
          const inherited = parentMaps[index]!.get(property);
          if (inherited) { selected = { ...inherited, source: "inherited" }; break; }
        }
      }
      if (!selected) continue;
      values[property] = { ...resolvedStyleValue(selected.value, context), source: selected.source };
    }
    if (Object.keys(values).length) variants.push({ breakpoint: width === 0 ? "base" : width, ...(state ? { state } : {}), values });
  }
  return { nodeId: entry.id, ...(displayName(entry.node, context.library, context.origins) ? { name: displayName(entry.node, context.library, context.origins) } : {}), variants };
}

/** 文書を変えずに、AI向けの小さな投影を生成する。 */
export function inspectPageDocument(document: PageDocument, queryValue: PageInspectQuery, options: PageInspectContext = {}): Record<string, unknown> {
  const query = parsePageInspectQuery(queryValue);
  if (!query) throw new PageInspectError("invalid_request");
  const context = prepare(document, options), entries = nodeEntries(context.document, context.library, context.origins);
  const documentFingerprint = stableHash(JSON.stringify(context.document));
  if (query.view === "effectiveStyle") {
    const entry = selectedEntry(entries, query.node!);
    const result = { view: query.view, nodeId: query.node, style: effectiveStyle(context, entry, entries) };
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > PAGE_INSPECT_LIMITS.maxResultBytes) throw new PageInspectError("result_too_large");
    return result;
  }
  if (query.view === "subtree") {
    const root = atPath(context.document, selectedEntry(entries, query.node!).path);
    const parts = subtreeEntries(root);
    const full = { view: query.view, nodeId: query.node, subtree: root, complete: true };
    if (new TextEncoder().encode(JSON.stringify(full)).byteLength <= PAGE_INSPECT_LIMITS.maxResultBytes && parts.length <= (query.limit ?? PAGE_INSPECT_LIMITS.defaultItems) && query.cursor === undefined) return full;
    return paginate(parts, query, documentFingerprint, { view: query.view, nodeId: query.node, complete: false, format: "path-nodes" });
  }
  const rootPath = query.view === "outline" && query.node !== undefined ? selectedEntry(entries, query.node).path : undefined;
  const rootDepth = rootPath === undefined ? 0 : rootPath.length - 1;
  const selectedEntries = query.view === "outline"
    ? entries.filter((entry) => (rootPath === undefined || entry.path.length >= rootPath.length
      && rootPath.every((part, index) => part === entry.path[index]))
      && (query.depth === undefined || entry.path.length - 1 - rootDepth <= query.depth))
    : entries.filter((entry) => queryMatches(entry, query, context.document, context.library, context.origins));
  const rows = selectedEntries.map((entry) => query.view === "outline"
    ? outlineRow(entry, context.document, context.library, context.origins)
    : { id: entry.id, ...(displayName(entry.node, context.library, context.origins) ? { name: displayName(entry.node, context.library, context.origins) } : {}),
      ancestors: entry.parentNames, text: excerpt(textOf(entry.node)) });
  const prefix: Record<string, unknown> = { view: query.view };
  if (query.view === "outline") {
    prefix.definitions = {
      tokens: Object.entries(context.document.tokens).map(([name, token]) => ({ name, type: token.type, value: token.value,
        source: Object.hasOwn(document.tokens, name) ? "page" : Object.hasOwn(options.siteStyles?.tokens ?? {}, name) ? "siteShared" : "component" })),
      textStyles: Object.keys(context.document.textStyles ?? {}).map((name) => ({ name,
        source: Object.hasOwn(document.textStyles ?? {}, name) ? "page" : "siteShared" })),
      breakpoints: responsiveWidths([context.document.body, context.document.textStyles])
    };
  }
  return paginate(rows, query, documentFingerprint, prefix);
}
