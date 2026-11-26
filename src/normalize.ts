import { parsePageDocument } from "./document.js";
import { breakpointUsageCount, parseBreakpointSettings, removeBreakpointSetting } from "./style-model.js";
import { parseSiteStyles, type SiteStyles } from "./site-styles.js";
import { textStyleProperties } from "./style-values.js";
import { walkNodes, type EditorOperationById, type NodePath } from "./editor-model.js";
import type { EditorBreakpointSettings, EditorTarget } from "./editor-types.js";
import type { DesignToken, ElementNode, NodeStyle, PageDocument, PageNode, StateName, StyleProperty, StyleValue, TextStyle, TextStyleProperty } from "./types.js";
import type { PageKind } from "./pages.js";
import { colorParts } from "./style-model.js";
import { parseComponentLibrary } from "./components.js";
import type { BlockContracts, ComponentLibrary } from "./types.js";
import { PAGE_OPERATION_LIMIT } from "./editing-page-operations.js";
import { mergeStyle } from "./component-expand.js";

export type NormalizationDocument = {
  readonly kind: PageKind;
  readonly version: string;
  readonly document: PageDocument;
};

export type NormalizationInput = {
  readonly siteId: string;
  readonly siteStyles: { readonly version: string; readonly styles: SiteStyles };
  readonly breakpoints: { readonly version: string; readonly settings: EditorBreakpointSettings };
  readonly blocks?: BlockContracts;
  readonly components?: { readonly version: string; readonly library: ComponentLibrary };
  readonly documents: readonly NormalizationDocument[];
};

export type NormalizationClassification = "lossless" | "semantic" | "lossy";
export type NormalizationOccurrence = {
  readonly target: EditorTarget;
  readonly nodeId: string;
  readonly path: NodePath;
  readonly property?: StyleProperty;
  readonly breakpoint?: number | "base";
  readonly state?: StateName;
  readonly slot?: string;
};

type ColorProposal = {
  readonly kind: "color-token";
  readonly id: string;
  readonly classification: "semantic";
  readonly tokenName: string;
  readonly value: string;
  readonly createToken: boolean;
  readonly occurrences: readonly NormalizationOccurrence[];
};
type TextStyleProposal = {
  readonly kind: "text-style";
  readonly id: string;
  readonly classification: "semantic";
  readonly styleName: string;
  readonly style: TextStyle;
  readonly occurrences: readonly NormalizationOccurrence[];
};
type RedundantStyleProposal = {
  readonly kind: "remove-redundant-override";
  readonly id: string;
  readonly classification: "lossless";
  readonly occurrence: NormalizationOccurrence;
  readonly value: StyleValue;
};
type BreakpointProposal = {
  readonly kind: "unused-breakpoint" | "merge-breakpoints";
  readonly id: string;
  readonly classification: "lossless" | "lossy";
  readonly removeName: EditorBreakpointSettings["breakpoints"][number]["name"];
  readonly minWidth: number;
  readonly keepName?: EditorBreakpointSettings["breakpoints"][number]["name"];
  readonly keepMinWidth?: number;
  readonly usageCount: number;
};
type SectionNameProposal = {
  readonly kind: "name-section";
  readonly id: string;
  readonly classification: "lossless";
  readonly occurrence: NormalizationOccurrence;
  readonly name: string;
};
export type NormalizationProposal = ColorProposal | TextStyleProposal | RedundantStyleProposal | BreakpointProposal | SectionNameProposal;

export type NormalizationAnalysis = {
  readonly schemaVersion: 1;
  readonly siteId: string;
  readonly proposalCount: number;
  readonly proposals: readonly NormalizationProposal[];
};

export type NormalizationPagePlan = {
  readonly target: EditorTarget;
  readonly expectedVersion: string;
  readonly operations: readonly EditorOperationById[];
};
export type NormalizationPlan = {
  readonly schemaVersion: 1;
  readonly siteId: string;
  readonly expectedSiteStylesVersion: string;
  readonly siteStyles: SiteStyles;
  readonly expectedBreakpointsVersion: string;
  readonly expectedComponentsVersion?: string;
  readonly breakpoints: EditorBreakpointSettings;
  readonly acceptedProposalIds: readonly string[];
  readonly pages: readonly NormalizationPagePlan[];
};

const COLOR_PROPERTIES = new Set<StyleProperty>([
  "color", "backgroundColor", "borderColor", "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor"
]);
const MAX_BREAKPOINT_MERGE_GAP = 64;
const MIN_PROPOSAL_OCCURRENCES = 2;
const MAX_ANALYSIS_NODES = 100_000;
const validVersion = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const stable = (value: unknown): string => JSON.stringify(value, (_key, entry) => {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => compareText(a, b)));
});

function hash(value: string): string {
  let result = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) result = BigInt.asUintN(64, (result ^ BigInt(byte)) * 0x100000001b3n);
  return result.toString(16).padStart(16, "0");
}
function proposalId(kind: string, value: unknown): string { return `${kind}-${hash(stable(value))}`; }
function checkedInput(input: NormalizationInput): NormalizationInput {
  if (!input || typeof input !== "object" || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(input.siteId)
    || !validVersion(input.siteStyles?.version) || !validVersion(input.breakpoints?.version)
    || !Array.isArray(input.documents) || input.documents.length > 500) throw new TypeError("invalid normalization input");
  let styles: SiteStyles, settings: EditorBreakpointSettings;
  try { styles = parseSiteStyles(input.siteStyles.styles); settings = parseBreakpointSettings(input.breakpoints.settings); }
  catch { throw new TypeError("invalid normalization context"); }
  const blocks = input.blocks ?? {};
  let components: { version: string; library: ComponentLibrary } | undefined;
  if (input.components !== undefined) {
    if (!validVersion(input.components.version)) throw new TypeError("invalid normalization component version");
    try {
      const library = parseComponentLibrary(input.components.library, blocks);
      if (library.siteId !== input.siteId) throw new TypeError("normalization component site mismatch");
      components = { version: input.components.version, library };
    } catch (error) {
      if (error instanceof TypeError && error.message === "normalization component site mismatch") throw error;
      throw new TypeError("invalid normalization component library");
    }
  }
  const seen = new Set<string>();
  let totalNodes = 0;
  const documents = input.documents.map((entry) => {
    if (!entry || typeof entry !== "object" || !validVersion(entry.version) || !["page", "template", "shared"].includes(entry.kind)) throw new TypeError("invalid normalization document");
    const document = parsePageDocument(entry.document, blocks, { siteStyles: styles, ...(components ? { components: components.library } : {}) });
    if (document.siteId !== input.siteId) throw new TypeError("normalization site mismatch");
    totalNodes += walkNodes(document).length;
    if (totalNodes > MAX_ANALYSIS_NODES) throw new TypeError("normalization input exceeds node limit");
    const key = `${document.pageId}\u0000${document.locale}`;
    if (seen.has(key)) throw new TypeError("duplicate normalization document");
    seen.add(key);
    return { kind: entry.kind, version: entry.version, document };
  }).sort((a, b) => compareText(`${a.kind}\u0000${a.document.pageId}\u0000${a.document.locale}`, `${b.kind}\u0000${b.document.pageId}\u0000${b.document.locale}`));
  return { siteId: input.siteId, siteStyles: { version: input.siteStyles.version, styles }, breakpoints: { version: input.breakpoints.version, settings },
    ...(input.blocks ? { blocks } : {}), ...(components ? { components } : {}), documents };
}
const targetFor = (document: PageDocument): EditorTarget => ({ siteId: document.siteId, pageId: document.pageId, locale: document.locale });
const targetKey = (target: EditorTarget): string => `${target.pageId}\u0000${target.locale}`;

function normalizeHexColor(value: string): string | undefined {
  if (!colorParts(value)) return undefined;
  const digits = value.slice(1).toLowerCase();
  const expanded = digits.length === 3 || digits.length === 4 ? [...digits].map((digit) => digit + digit).join("") : digits;
  return `#${expanded}`;
}
function colorTokenName(color: string, names: ReadonlySet<string>): string {
  const base = `color-${color.slice(1)}`;
  if (!names.has(base)) return base;
  let suffix = 2;
  while (names.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}
function allStyleValues(document: PageDocument, visit: (value: unknown, location: NormalizationOccurrence) => void): void {
  const target = targetFor(document);
  for (const { node, path } of walkNodes(document)) {
    if (node.type === "text") continue;
    const base = node.style?.base;
    if (base) for (const [property, value] of Object.entries(base)) visit(value, { target, nodeId: node.id, path, property: property as StyleProperty, breakpoint: "base" });
    for (const entry of node.style?.responsive ?? []) for (const [property, value] of Object.entries(entry.declarations)) {
      visit(value, { target, nodeId: node.id, path, property: property as StyleProperty, breakpoint: entry.minWidth });
    }
    for (const [state, values] of Object.entries(node.style?.states ?? [])) for (const [property, value] of Object.entries(values)) {
      visit(value, { target, nodeId: node.id, path, property: property as StyleProperty, state: state as StateName });
    }
    if (node.type === "component") for (const [slot, style] of Object.entries(node.slots ?? {})) {
      for (const [property, value] of Object.entries(style.base ?? {})) visit(value, { target, nodeId: node.id, path, property: property as StyleProperty, breakpoint: "base", slot });
      for (const entry of style.responsive ?? []) for (const [property, value] of Object.entries(entry.declarations)) {
        visit(value, { target, nodeId: node.id, path, property: property as StyleProperty, breakpoint: entry.minWidth, slot });
      }
    }
  }
}
function textStyleFor(node: Exclude<PageNode, { type: "text" }>, document: PageDocument, site: SiteStyles, componentTokens: ComponentLibrary["tokens"]): TextStyle | undefined {
  if (node.style?.textStyle) return undefined;
  const siteTokens = site.tokens ?? {}, localTokens = { ...componentTokens, ...siteTokens, ...document.tokens };
  const filter = (values: Record<string, unknown> | undefined): Partial<Record<TextStyleProperty, StyleValue>> => {
    const result: Partial<Record<TextStyleProperty, StyleValue>> = {};
    for (const [property, value] of Object.entries(values ?? {})) {
      if (!(textStyleProperties as readonly string[]).includes(property)) continue;
      if (typeof value === "string" || typeof value === "number") result[property as TextStyleProperty] = value;
      else if (value && typeof value === "object" && typeof (value as { token?: unknown }).token === "string") {
        const name = (value as { token: string }).token;
        if (Object.hasOwn(siteTokens, name) && !Object.hasOwn(document.tokens, name)) result[property as TextStyleProperty] = value as StyleValue;
        else {
          const token = localTokens[name];
          if (token) result[property as TextStyleProperty] = token.value;
        }
      }
    }
    return result;
  };
  const base = filter(node.style?.base as Record<string, unknown> | undefined);
  const responsive = (node.style?.responsive ?? []).flatMap((entry) => {
    const declarations = filter(entry.declarations as Record<string, unknown>);
    return Object.keys(declarations).length ? [{ minWidth: entry.minWidth, declarations }] : [];
  });
  if (!Object.keys(base).length && !responsive.length) return undefined;
  return { base, ...(responsive.length ? { responsive } : {}) };
}
function textOf(node: PageNode): string {
  if (node.type === "text") return node.text;
  if (node.type !== "element") return "";
  return node.children.map(textOf).join(" ");
}
function sectionCandidate(node: ElementNode): string {
  const findHeading = (parent: ElementNode): string | undefined => {
    for (const child of parent.children) if (child.type === "element" && /^h[1-6]$/u.test(child.tag)) {
      const value = textOf(child).replace(/\s+/gu, " ").trim();
      if (value) return value;
    }
    for (const child of parent.children) if (child.type === "element") {
      const value = findHeading(child);
      if (value) return value;
    }
    return undefined;
  };
  return findHeading(node) ?? textOf(node);
}
function descendantElementCount(node: ElementNode): number {
  return node.children.reduce((count, child) => count + (child.type === "element" ? 1 + descendantElementCount(child) : 0), 0);
}
function componentBreakpointUsageCount(library: ComponentLibrary | undefined, minWidth: number): number {
  if (!library) return 0;
  let count = 0;
  for (const component of library.components) {
    const pending: PageNode[] = [component.root];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === "text") continue;
      count += (node.style?.responsive ?? []).filter((entry) => entry.minWidth === minWidth).length;
      count += (node.style?.hidden ?? []).filter((entry) => entry.minWidth === minWidth || entry.maxWidth === minWidth - 1).length;
      if (node.type === "component") for (const style of Object.values(node.slots ?? {})) {
        count += (style.responsive ?? []).filter((entry) => entry.minWidth === minWidth).length;
      }
      if (node.type === "element") pending.push(...node.children);
    }
  }
  return count;
}
function tokenUsageAt(styles: SiteStyles, documents: readonly NormalizationDocument[], minWidth: number, library?: ComponentLibrary): number {
  let count = 0;
  for (const style of Object.values(styles.textStyles ?? {})) count += (style.responsive ?? []).filter((entry) => entry.minWidth === minWidth).length;
  for (const { document } of documents) count += breakpointUsageCount(document, minWidth);
  return count + componentBreakpointUsageCount(library, minWidth);
}
function styleBreakpointUsageCount(styles: SiteStyles, documents: readonly NormalizationDocument[], minWidth: number, library?: ComponentLibrary): number {
  let count = Object.values(styles.textStyles ?? {}).reduce((sum, style) => sum + (style.responsive ?? []).filter((entry) => entry.minWidth === minWidth).length, 0);
  for (const { document } of documents) {
    count += (document.textStyles ? Object.values(document.textStyles) : []).reduce((sum, style) => sum + (style.responsive ?? []).filter((entry) => entry.minWidth === minWidth).length, 0);
    for (const { node } of walkNodes(document)) {
      if (node.type === "text") continue;
      count += (node.style?.responsive ?? []).filter((entry) => entry.minWidth === minWidth).length;
      if (node.type === "component") for (const style of Object.values(node.slots ?? {})) count += (style.responsive ?? []).filter((entry) => entry.minWidth === minWidth).length;
    }
  }
  return count + componentBreakpointUsageCount(library, minWidth);
}

/** サイト横断で、実装可能な正規化候補を決定的に抽出する。 */
function analyzeCheckedInput(input: NormalizationInput): NormalizationAnalysis {
  const proposals: NormalizationProposal[] = [];
  const colorGroups = new Map<string, NormalizationOccurrence[]>();
  for (const { document } of input.documents) allStyleValues(document, (value, location) => {
    const property = location.property;
    if (!property || !COLOR_PROPERTIES.has(property) || typeof value !== "string") return;
    const color = normalizeHexColor(value);
    if (!color) return;
    const occurrences = colorGroups.get(color) ?? [];
    occurrences.push(location);
    colorGroups.set(color, occurrences);
  });
  for (const [value, occurrences] of colorGroups) {
    if (occurrences.length < MIN_PROPOSAL_OCCURRENCES) continue;
    const names = new Set([
      ...Object.keys(input.siteStyles.styles.tokens ?? {}),
      ...Object.keys(input.components?.library.tokens ?? {}),
      ...input.documents.flatMap(({ document }) => Object.keys(document.tokens))
    ]);
    const existing = Object.entries(input.siteStyles.styles.tokens ?? {}).find(([name, token]) => token.type === "color"
      && normalizeHexColor(String(token.value)) === value
      && input.documents.every(({ document }) => !document.tokens[name] || normalizeHexColor(String(document.tokens[name]!.value)) === value));
    const tokenName = existing?.[0] ?? colorTokenName(value, names);
    const sortedOccurrences = [...occurrences].sort((a, b) => compareText(`${targetKey(a.target)}\u0000${a.nodeId}\u0000${a.slot ?? ""}\u0000${a.state ?? ""}\u0000${a.breakpoint ?? "base"}\u0000${a.property}`,
      `${targetKey(b.target)}\u0000${b.nodeId}\u0000${b.slot ?? ""}\u0000${b.state ?? ""}\u0000${b.breakpoint ?? "base"}\u0000${b.property}`));
    proposals.push({ kind: "color-token", id: proposalId("color", { value, tokenName, occurrences: sortedOccurrences }), classification: "semantic",
      tokenName, value, createToken: existing === undefined, occurrences: sortedOccurrences });
  }

  const textGroups = new Map<string, { style: TextStyle; occurrences: NormalizationOccurrence[] }>();
  for (const { document } of input.documents) for (const { node, path } of walkNodes(document)) {
    if (node.type === "text") continue;
    const style = textStyleFor(node, document, input.siteStyles.styles, node.type === "instance" ? input.components?.library.tokens ?? {} : {});
    if (!style) continue;
    const key = stable(style), group = textGroups.get(key) ?? { style, occurrences: [] };
    group.occurrences.push({ target: targetFor(document), nodeId: node.id, path });
    textGroups.set(key, group);
  }
  const usedTextStyleNames = new Set([...Object.keys(input.siteStyles.styles.textStyles ?? {}), ...input.documents.flatMap(({ document }) => Object.keys(document.textStyles ?? {}))]);
  for (const { style, occurrences } of textGroups.values()) {
    if (occurrences.length < MIN_PROPOSAL_OCCURRENCES) continue;
    let index = 1;
    while (usedTextStyleNames.has(`text-style-${index}`)) index++;
    const styleName = `text-style-${index}`;
    usedTextStyleNames.add(styleName);
    const sortedOccurrences = [...occurrences].sort((a, b) => compareText(`${targetKey(a.target)}\u0000${a.nodeId}`, `${targetKey(b.target)}\u0000${b.nodeId}`));
    proposals.push({ kind: "text-style", id: proposalId("text-style", { style, styleName, occurrences: sortedOccurrences }), classification: "semantic", styleName, style, occurrences: sortedOccurrences });
  }

  for (const { document } of input.documents) {
    const effectiveDocument = { ...document, tokens: { ...(input.components?.library.tokens ?? {}), ...(input.siteStyles.styles.tokens ?? {}), ...document.tokens },
      textStyles: { ...(input.siteStyles.styles.textStyles ?? {}), ...(document.textStyles ?? {}) } };
    const effectiveNodes = new Map(walkNodes(effectiveDocument).flatMap(({ node }) => node.type === "text" ? [] : [[node.id, node] as const]));
    for (const { node, path } of walkNodes(document)) {
      if (node.type === "text") continue;
      const effectiveNode = effectiveNodes.get(node.id);
      if (!effectiveNode) continue;
      const inspectResponsive = (sourceStyle: NodeStyle | undefined, slot?: string, componentRootStyle?: NodeStyle) => {
        const beforeStyle = componentRootStyle ? mergeStyle(componentRootStyle, sourceStyle ?? {}) : sourceStyle;
        const responsive = sourceStyle?.responsive ?? [];
        for (const entry of responsive) for (const [property, value] of Object.entries(entry.declarations) as [StyleProperty, StyleValue][]) {
          const nextOverride = (beforeStyle?.responsive ?? []).find((candidate) => candidate.minWidth > entry.minWidth && candidate.declarations[property] !== undefined)?.minWidth ?? 3841;
          const afterSourceStyle = removeResponsiveProperty(sourceStyle, entry.minWidth, property);
          const afterStyle = componentRootStyle ? mergeStyle(componentRootStyle, afterSourceStyle ?? {}) : afterSourceStyle;
          const textStyleName = beforeStyle?.textStyle;
          const boundaries = new Set([entry.minWidth, ...(beforeStyle?.responsive ?? []).filter((candidate) => candidate.minWidth > entry.minWidth && candidate.minWidth < nextOverride).map((candidate) => candidate.minWidth),
            ...(!slot && textStyleName ? (effectiveDocument.textStyles?.[textStyleName]?.responsive ?? []).filter((candidate) => candidate.minWidth >= entry.minWidth && candidate.minWidth < nextOverride).map((candidate) => candidate.minWidth) : [])]);
          const sameAtEveryBoundary = [...boundaries].every((width) => {
            const inherited = !slot && textStyleName ? inheritedTextValue(effectiveDocument, effectiveNode, property, width, textStyleName) : undefined;
            const before = valueAtWidth(beforeStyle, property, width) ?? inherited;
            const after = valueAtWidth(afterStyle, property, width) ?? inherited;
            return stable(resolveStyleValue(effectiveDocument, before)) === stable(resolveStyleValue(effectiveDocument, after));
          });
          if (!sameAtEveryBoundary) continue;
          const occurrence = { target: targetFor(document), nodeId: node.id, path, breakpoint: entry.minWidth, property, ...(slot ? { slot } : {}) };
          proposals.push({ kind: "remove-redundant-override", id: proposalId("redundant", occurrence), classification: "lossless", occurrence, value });
        }
      };
      if (effectiveNode.type === "instance") {
        const component = input.components?.library.components.find(({ id }) => id === effectiveNode.component);
        inspectResponsive(effectiveNode.style, undefined, component?.root.style);
      } else inspectResponsive(effectiveNode.style);
      if (effectiveNode.type === "component") for (const [slot, style] of Object.entries(effectiveNode.slots ?? {})) inspectResponsive(style, slot);
    }
    for (const { node, path } of walkNodes(document)) {
      if (node.type !== "element" || node.tag !== "section" || node.name?.trim() || descendantElementCount(node) < 4) continue;
      const candidate = sectionCandidate(node).replace(/\s+/gu, " ").trim().slice(0, 40);
      if (!candidate) continue;
      const occurrence = { target: targetFor(document), nodeId: node.id, path };
      proposals.push({ kind: "name-section", id: proposalId("section-name", { occurrence, name: candidate }), classification: "lossless", occurrence, name: candidate });
    }
  }

  const settings = input.breakpoints.settings;
  for (const [index, breakpoint] of settings.breakpoints.entries()) {
    const usageCount = tokenUsageAt(input.siteStyles.styles, input.documents, breakpoint.minWidth, input.components?.library);
    if (usageCount === 0 && breakpoint.name !== "PC") proposals.push({ kind: "unused-breakpoint", id: proposalId("unused-breakpoint", breakpoint), classification: "lossless",
      removeName: breakpoint.name, minWidth: breakpoint.minWidth, usageCount });
    const next = settings.breakpoints[index + 1];
    const styleUsage = styleBreakpointUsageCount(input.siteStyles.styles, input.documents, breakpoint.minWidth, input.components?.library);
    const nextStyleUsage = next ? styleBreakpointUsageCount(input.siteStyles.styles, input.documents, next.minWidth, input.components?.library) : 0;
    const libraryUsesEither = componentBreakpointUsageCount(input.components?.library, breakpoint.minWidth) > 0
      || next !== undefined && componentBreakpointUsageCount(input.components?.library, next.minWidth) > 0;
    if (next && !libraryUsesEither && next.minWidth - breakpoint.minWidth <= MAX_BREAKPOINT_MERGE_GAP && styleUsage > 0 && nextStyleUsage > 0) {
      const remove = next.name === "PC" ? breakpoint : next, keep = remove === next ? breakpoint : next;
      proposals.push({ kind: "merge-breakpoints", id: proposalId("merge-breakpoints", { remove, keep }), classification: "lossy",
        removeName: remove.name, minWidth: remove.minWidth, keepName: keep.name, keepMinWidth: keep.minWidth,
        usageCount: styleBreakpointUsageCount(input.siteStyles.styles, input.documents, remove.minWidth, input.components?.library) });
    }
  }

  proposals.sort((a, b) => compareText(a.kind, b.kind) || compareText(a.id, b.id));
  return { schemaVersion: 1, siteId: input.siteId, proposalCount: proposals.length, proposals };
}

export function analyzeNormalization(inputValue: NormalizationInput): NormalizationAnalysis {
  return analyzeCheckedInput(checkedInput(inputValue));
}

function inheritedTextValue(document: PageDocument, node: Exclude<PageNode, { type: "text" }>, property: StyleProperty, width: number, textStyleName = node.style?.textStyle): StyleValue | undefined {
  const name = textStyleName;
  const style = name ? document.textStyles?.[name] : undefined;
  if (!style || !(textStyleProperties as readonly string[]).includes(property)) return undefined;
  let value = style.base[property as TextStyleProperty];
  for (const entry of style.responsive ?? []) if (entry.minWidth <= width && entry.declarations[property as TextStyleProperty] !== undefined) value = entry.declarations[property as TextStyleProperty];
  return value;
}
function valueAtWidth(style: NodeStyle | undefined, property: StyleProperty, width: number): StyleValue | undefined {
  let value = style?.base?.[property];
  for (const entry of style?.responsive ?? []) if (entry.minWidth <= width && entry.declarations[property] !== undefined) value = entry.declarations[property];
  return value;
}
function removeResponsiveProperty(style: NodeStyle | undefined, minWidth: number, property: StyleProperty): NodeStyle | undefined {
  if (!style) return undefined;
  const responsive = (style.responsive ?? []).map((entry) => {
    if (entry.minWidth !== minWidth) return entry;
    const declarations = { ...entry.declarations };
    delete declarations[property];
    return { ...entry, declarations };
  }).filter((entry) => Object.keys(entry.declarations).length > 0);
  const { responsive: _responsive, ...base } = style;
  const result: NodeStyle = { ...base, ...(responsive.length ? { responsive } : {}) };
  return Object.keys(result).length ? result : undefined;
}
function resolveStyleValue(document: PageDocument, value: StyleValue | undefined): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "object") return document.tokens[value.token]?.value;
  return value;
}
function coalesceOperations(operations: readonly EditorOperationById[]): EditorOperationById[] {
  type StyleOperation = Extract<EditorOperationById, { type: "style" }>;
  type StateOperation = Extract<EditorOperationById, { type: "state" }>;
  const styleGroups = new Map<string, { index: number; first: StyleOperation; values: Partial<Record<StyleProperty, StyleValue | undefined>>; count: number }>();
  const stateGroups = new Map<string, { index: number; first: StateOperation; values: StateOperation["values"]; count: number }>();
  operations.forEach((operation, index) => {
    if (operation.type === "style") {
      const key = `${operation.nodeId}\u0000${operation.breakpoint}`, group = styleGroups.get(key);
      if (group) {
        if (Object.hasOwn(group.values, operation.property) && stable(group.values[operation.property]) !== stable(operation.value)) throw new TypeError("conflicting normalization style operations");
        group.values[operation.property] = operation.value; group.count++;
      } else styleGroups.set(key, { index, first: operation, values: { [operation.property]: operation.value }, count: 1 });
    } else if (operation.type === "state") {
      const key = `${operation.nodeId}\u0000${operation.state}`, group = stateGroups.get(key);
      if (group) {
        for (const [property, value] of Object.entries(operation.values)) {
          if (Object.hasOwn(group.values, property) && stable(group.values[property as keyof typeof group.values]) !== stable(value)) throw new TypeError("conflicting normalization state operations");
          group.values[property as keyof typeof group.values] = value;
        }
        group.count++;
      } else stateGroups.set(key, { index, first: operation, values: { ...operation.values }, count: 1 });
    }
  });
  return operations.flatMap((operation, index): EditorOperationById[] => {
    if (operation.type === "style") {
      const group = styleGroups.get(`${operation.nodeId}\u0000${operation.breakpoint}`)!;
      if (group.index !== index) return [];
      return [group.count > 1 ? { type: "styles", nodeId: operation.nodeId, breakpoint: operation.breakpoint, values: group.values } : operation];
    }
    if (operation.type === "state") {
      const group = stateGroups.get(`${operation.nodeId}\u0000${operation.state}`)!;
      if (group.index !== index) return [];
      return [group.count > 1 ? { ...group.first, values: group.values } : operation];
    }
    return [operation];
  });
}

/** lossless候補は既定で含め、semantic / lossy候補はIDを明示承認したものだけ計画する。 */
export function planNormalization(inputValue: NormalizationInput, approvedProposalIds: readonly string[] = []): NormalizationPlan {
  const input = checkedInput(inputValue), analysis = analyzeCheckedInput(input), approvals = new Set(approvedProposalIds);
  if (approvals.size !== approvedProposalIds.length || [...approvals].some((id) => !analysis.proposals.some((proposal) => proposal.id === id))) throw new TypeError("unknown normalization approval");
  const accepted = analysis.proposals.filter((proposal) => proposal.classification === "lossless" || approvals.has(proposal.id));
  const mergeWidths = new Set(accepted.filter((proposal): proposal is BreakpointProposal => proposal.kind === "merge-breakpoints").map(({ minWidth }) => minWidth));
  for (const proposal of accepted) {
    if (proposal.kind === "color-token" && proposal.occurrences.some((occurrence) => typeof occurrence.breakpoint === "number" && mergeWidths.has(occurrence.breakpoint))) {
      throw new TypeError("normalization color proposal overlaps a merged breakpoint");
    }
    if (proposal.kind === "text-style" && (proposal.style.responsive ?? []).some(({ minWidth }) => mergeWidths.has(minWidth))) {
      throw new TypeError("normalization text style overlaps a merged breakpoint");
    }
  }
  const redundantKeys = new Set(accepted.flatMap((proposal) => proposal.kind === "remove-redundant-override"
    ? [`${targetKey(proposal.occurrence.target)}\u0000${proposal.occurrence.nodeId}\u0000${proposal.occurrence.slot ?? ""}\u0000${proposal.occurrence.state ?? ""}\u0000${proposal.occurrence.breakpoint ?? "base"}\u0000${proposal.occurrence.property}`] : []));
  for (const proposal of accepted) if (proposal.kind === "color-token" && proposal.occurrences.some((occurrence) => redundantKeys.has(
    `${targetKey(occurrence.target)}\u0000${occurrence.nodeId}\u0000${occurrence.slot ?? ""}\u0000${occurrence.state ?? ""}\u0000${occurrence.breakpoint ?? "base"}\u0000${occurrence.property}`))) {
    throw new TypeError("normalization color proposal overlaps a redundant override");
  }
  const styles = structuredClone(input.siteStyles.styles), breakpoints = structuredClone(input.breakpoints.settings);
  const pageOperations = new Map<string, { target: EditorTarget; expectedVersion: string; operations: EditorOperationById[] }>();
  const pageFor = (target: EditorTarget) => input.documents.find(({ document }) => targetKey(targetFor(document)) === targetKey(target));
  const addOperation = (target: EditorTarget, operation: EditorOperationById) => {
    const source = pageFor(target);
    if (!source) throw new TypeError("normalization target missing");
    const key = targetKey(target), page = pageOperations.get(key) ?? { target, expectedVersion: source.version, operations: [] };
    page.operations.push(operation); pageOperations.set(key, page);
  };
  const removedBreakpoints = new Set<number>();
  const mergedBreakpoints = new Set(accepted.flatMap((proposal) => proposal.kind === "merge-breakpoints" ? [proposal.minWidth] : []));
  for (const proposal of accepted) if (proposal.kind === "unused-breakpoint" || proposal.kind === "merge-breakpoints") {
    if (removedBreakpoints.has(proposal.minWidth)) throw new TypeError("overlapping breakpoint proposals");
    removedBreakpoints.add(proposal.minWidth);
    breakpoints.breakpoints = removeBreakpointSetting(breakpoints, proposal.removeName).breakpoints;
  }
  if (mergedBreakpoints.size) {
    for (const [name, style] of Object.entries(styles.textStyles ?? {})) if (style.responsive?.some((entry) => mergedBreakpoints.has(entry.minWidth))) {
      styles.textStyles![name] = { ...style, responsive: style.responsive.filter((entry) => !mergedBreakpoints.has(entry.minWidth)) };
    }
    for (const { document } of input.documents) {
      const target = targetFor(document);
      for (const { node } of walkNodes(document)) {
        if (node.type === "text") continue;
        for (const entry of node.style?.responsive ?? []) if (mergedBreakpoints.has(entry.minWidth)) for (const property of Object.keys(entry.declarations) as StyleProperty[]) {
          addOperation(target, { type: "style", nodeId: node.id, breakpoint: entry.minWidth, property, value: undefined });
        }
        if (node.type === "component") for (const [slot, style] of Object.entries(node.slots ?? {})) for (const entry of style.responsive ?? []) {
          if (mergedBreakpoints.has(entry.minWidth)) for (const property of Object.keys(entry.declarations) as StyleProperty[]) addOperation(target, { type: "slotStyle", nodeId: node.id, slot, breakpoint: entry.minWidth, property, value: undefined });
        }
      }
      for (const [name, style] of Object.entries(document.textStyles ?? {})) if (style.responsive?.some((entry) => mergedBreakpoints.has(entry.minWidth))) {
        addOperation(target, { type: "textStyle", name, style: { ...style, responsive: style.responsive.filter((entry) => !mergedBreakpoints.has(entry.minWidth)) } });
      }
    }
  }
  for (const proposal of accepted) {
    if (proposal.kind === "color-token") {
      if (proposal.createToken) styles.tokens = { ...(styles.tokens ?? {}), [proposal.tokenName]: { type: "color", value: proposal.value } satisfies DesignToken };
      for (const occurrence of proposal.occurrences) {
        const value = { token: proposal.tokenName };
        if (occurrence.slot) addOperation(occurrence.target, { type: "slotStyle", nodeId: occurrence.nodeId, slot: occurrence.slot, breakpoint: occurrence.breakpoint ?? "base", property: occurrence.property!, value });
        else if (occurrence.state) addOperation(occurrence.target, { type: "state", nodeId: occurrence.nodeId, state: occurrence.state, values: { [occurrence.property!]: value } });
        else addOperation(occurrence.target, { type: "style", nodeId: occurrence.nodeId, breakpoint: occurrence.breakpoint ?? "base", property: occurrence.property!, value });
      }
    } else if (proposal.kind === "text-style") {
      styles.textStyles = { ...(styles.textStyles ?? {}), [proposal.styleName]: structuredClone(proposal.style) };
      for (const occurrence of proposal.occurrences) {
        addOperation(occurrence.target, { type: "nodeTextStyle", nodeId: occurrence.nodeId, name: proposal.styleName });
        const document = pageFor(occurrence.target)!.document;
        const node = walkNodes(document).find(({ node: candidate }) => candidate.type !== "text" && candidate.id === occurrence.nodeId)?.node;
        if (!node || node.type === "text") continue;
        for (const property of Object.keys(proposal.style.base) as StyleProperty[]) addOperation(occurrence.target, { type: "style", nodeId: occurrence.nodeId, breakpoint: "base", property, value: undefined });
        for (const entry of proposal.style.responsive ?? []) for (const property of Object.keys(entry.declarations) as StyleProperty[]) addOperation(occurrence.target, { type: "style", nodeId: occurrence.nodeId, breakpoint: entry.minWidth, property, value: undefined });
      }
    } else if (proposal.kind === "remove-redundant-override") {
      if (proposal.occurrence.slot) addOperation(proposal.occurrence.target, { type: "slotStyle", nodeId: proposal.occurrence.nodeId, slot: proposal.occurrence.slot, breakpoint: proposal.occurrence.breakpoint!, property: proposal.occurrence.property!, value: undefined });
      else addOperation(proposal.occurrence.target, { type: "style", nodeId: proposal.occurrence.nodeId, breakpoint: proposal.occurrence.breakpoint!, property: proposal.occurrence.property!, value: undefined });
    } else if (proposal.kind === "name-section") {
      addOperation(proposal.occurrence.target, { type: "name", nodeId: proposal.occurrence.nodeId, value: proposal.name });
    }
  }
  const pages = [...pageOperations.values()].map(({ target, expectedVersion, operations }) => ({ target, expectedVersion, operations: coalesceOperations(operations) }))
    .filter((page) => page.operations.length > 0)
    .sort((a, b) => compareText(targetKey(a.target), targetKey(b.target)));
  if (pages.some((page) => page.operations.length > PAGE_OPERATION_LIMIT)) throw new TypeError("normalization page exceeds the single-apply operation limit");
  const expectedComponentsVersion = input.components?.version;
  return { schemaVersion: 1, siteId: input.siteId, expectedSiteStylesVersion: input.siteStyles.version, siteStyles: parseSiteStyles(styles),
    expectedBreakpointsVersion: input.breakpoints.version, ...(expectedComponentsVersion ? { expectedComponentsVersion } : {}), breakpoints: parseBreakpointSettings(breakpoints),
    acceptedProposalIds: accepted.map(({ id }) => id).sort(), pages };
}
