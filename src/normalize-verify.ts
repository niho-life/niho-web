import { resolvePageDocument } from "./components.js";
import { instancesOf } from "./component-expand.js";
import { styleDeclarationOrder } from "./css.js";
import { parsePageDocument } from "./document.js";
import type { NormalizationInput, NormalizationVerification } from "./normalize.js";
import { parseSitePresentation, presentationLayoutDocument } from "./presentation.js";
import { declarationCss, stateNames } from "./style-values.js";
import type { NodeStyle, PageDocument, PageNode, StateName, StyleDeclarations, TextStyle } from "./types.js";

type Property = keyof StyleDeclarations;
const shorthandGroups: readonly (readonly Property[])[] = [
  ["margin", "marginTop", "marginRight", "marginBottom", "marginLeft"],
  ["padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"],
  ["borderColor", "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor"],
  ["borderStyle", "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle"],
  ["borderWidth", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"],
  ["gap", "rowGap", "columnGap"],
  ["overflow", "overflowX"]
];

// Object property insertion order is irrelevant for document identity and value comparison.
export function normalizationKey(value: unknown): string {
  const sortable = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sortable);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, child]) => [key, sortable(child)]));
    }
    return entry;
  };
  return JSON.stringify(sortable(value)) ?? "";
}

const targetKey = (document: PageDocument) => JSON.stringify([document.siteId, document.pageId, document.locale]);

function comparisonWidths(styles: readonly (NodeStyle | TextStyle | undefined)[]): number[] {
  const widths = new Set([0]);
  function sample(boundary: number): void {
    widths.add(Math.max(0, boundary - 0.001));
    widths.add(boundary);
    widths.add(boundary + 0.001);
  }
  for (const style of styles) {
    for (const tier of style?.responsive ?? []) sample(tier.minWidth);
    if (style && "hidden" in style) for (const range of style.hidden ?? []) {
      sample(range.minWidth);
      if (range.maxWidth !== undefined) sample(range.maxWidth + 0.98);
    }
  }
  return [...widths].sort((a, b) => a - b);
}

/**
 * Compare winners in the renderer's order. Preserve CSS variables symbolically, and
 * separately compare their definitions in the document; this also preserves future
 * cascade behavior of the same token inside responsive rules.
 */
function inputs(style: NodeStyle | undefined, textStyle: TextStyle | undefined, width: number, mask: number): string {
  const declarationsByProperty = new Map<Property, string[]>();
  const shorthandInputs: string[][] = shorthandGroups.map(() => []);
  const apply = (declarations: StyleDeclarations | undefined): void => {
    if (!declarations) return;
    for (const property of styleDeclarationOrder(declarations)) {
      const css = property === "backgroundImage"
        ? `background-image:${normalizationKey(declarations.backgroundImage)}`
        : declarationCss(property, declarations[property]!);
      const previous = declarationsByProperty.get(property);
      // Keep fallbacks and shorthand collisions. Only consecutive repetitions of
      // an identical declaration are redundant for these inputs.
      if (!previous) declarationsByProperty.set(property, [css]);
      else if (previous.at(-1) !== css) previous.push(css);
      const shorthand = shorthandGroups.findIndex((group) => group.includes(property));
      if (shorthand >= 0 && shorthandInputs[shorthand]!.at(-1) !== css) shorthandInputs[shorthand]!.push(css);
    }
  };
  apply(textStyle?.base);
  for (const tier of textStyle?.responsive ?? []) if (tier.minWidth <= width) apply(tier.declarations);
  apply(style?.base);
  for (const tier of style?.responsive ?? []) if (tier.minWidth <= width) apply(tier.declarations);
  for (const [index, state] of stateNames.entries()) if (mask & (1 << index)) apply(style?.states?.[state]);
  const hidden = style?.hidden?.some(({ minWidth, maxWidth }) => minWidth <= width && (maxWidth === undefined || width <= maxWidth + 0.98)) ?? false;
  return normalizationKey({ values: Object.fromEntries(declarationsByProperty), shorthandInputs, hidden });
}

const backgroundIsolation = (style: NodeStyle | undefined) => style?.base?.backgroundFilter !== undefined
  || (style?.responsive?.some(({ declarations }) => declarations.backgroundFilter !== undefined) ?? false);

type Difference = { readonly nodeId?: string; readonly slot?: string; readonly width?: number; readonly states?: readonly StateName[]; readonly reason: string };

function styleDifference(
  left: NodeStyle | undefined, right: NodeStyle | undefined, leftText: TextStyle | undefined, rightText: TextStyle | undefined
): Difference | undefined {
  if (normalizationKey(left) === normalizationKey(right) && normalizationKey(leftText) === normalizationKey(rightText)) return undefined;
  if (backgroundIsolation(left) !== backgroundIsolation(right) || normalizationKey(left?.appear) !== normalizationKey(right?.appear)
    || normalizationKey(left?.states) !== normalizationKey(right?.states)) return { reason: "background_motion_or_state_inputs" };
  for (const width of comparisonWidths([left, right, leftText, rightText])) {
    // CSS pseudo classes can be active simultaneously, so include their combinations.
    for (let mask = 0; mask < 1 << stateNames.length; mask++) {
      if (inputs(left, leftText, width, mask) !== inputs(right, rightText, width, mask)) {
        return { reason: "style_inputs", width, states: stateNames.filter((_, index) => mask & (1 << index)) };
      }
    }
  }
  return undefined;
}

function documentDifference(left: PageDocument, right: PageDocument): Difference | undefined {
  if (left.title !== right.title || normalizationKey(left.meta) !== normalizationKey(right.meta)) return { reason: "document_inputs" };
  if (normalizationKey(left.tokens) !== normalizationKey(right.tokens)) return { reason: "token_definitions" };
  const compareNodes = (before: readonly PageNode[], after: readonly PageNode[]): Difference | undefined => {
    if (before.length !== after.length) return { reason: "structure" };
    for (const [index, node] of before.entries()) {
      const other = after[index]!;
      if (node.type === "text" || other.type === "text") {
        if (normalizationKey(node) !== normalizationKey(other)) return { reason: "text" };
        continue;
      }
      const shape = (entry: Exclude<PageNode, {type: "text"}>) => {
        const { style: _style, name: _name, ...input } = entry;
        if (input.type === "element") {
          const { children: _children, ...element } = input;
          return element;
        }
        if (input.type === "component") {
          const { slots: _slots, ...component } = input;
          return component;
        }
        return input;
      };
      if (normalizationKey(shape(node)) !== normalizationKey(shape(other))) return { nodeId: node.id, reason: "node_inputs" };
      const leftText = node.style?.textStyle ? left.textStyles?.[node.style.textStyle] : undefined;
      const rightText = other.style?.textStyle ? right.textStyles?.[other.style.textStyle] : undefined;
      const result = styleDifference(node.style, other.style, leftText, rightText);
      if (result) return { nodeId: node.id, ...result };
      if (node.type === "component" && other.type === "component") {
        const slots = new Set([...Object.keys(node.slots ?? {}), ...Object.keys(other.slots ?? {})]);
        for (const slot of slots) {
          const difference = styleDifference(node.slots?.[slot], other.slots?.[slot], undefined, undefined);
          if (difference) return { nodeId: node.id, slot, ...difference };
        }
      }
      if (node.type === "element" && other.type === "element") {
        const rest = compareNodes(node.children, other.children);
        if (rest) return rest;
      }
    }
    return undefined;
  };
  return compareNodes(left.body, right.body);
}

/**
 * Both sides use the same versioned context. Each local responsive function is
 * constant between its own boundaries: equality on those intervals implies
 * equality at every other node's boundaries too. Equal local inputs and DOM
 * structure also preserve parent inheritance, including state and hidden inputs.
 */
export function verifyNormalization(input: NormalizationInput, afterDocuments: readonly PageDocument[]): NormalizationVerification {
  const documents = input.documents.map((entry) => "document" in entry ? entry : { document: entry });
  if (documents.length !== afterDocuments.length
    || documents.some(({ document }, index) => targetKey(document) !== targetKey(afterDocuments[index]!))) {
    return { status: "unsupported", reason: "document_targets_or_order" };
  }
  const componentVersions = new Set(documents.flatMap(({ componentsVersion }) => componentsVersion === undefined ? [] : [componentsVersion]));
  if (input.siteStylesRevision && !input.siteStyles || componentVersions.size > 1 || componentVersions.size && !input.components
    || documents.some(({ componentsVersion }) => componentsVersion !== undefined && componentsVersion !== input.componentsVersion)
    || input.componentsVersion !== undefined && !input.components
    || !input.components && documents.some(({ document }) => instancesOf(document.body).length > 0)
    || documents.some(({ presentation, presentationVersion }) => presentationVersion !== undefined && presentation?.version !== presentationVersion)) {
    return { status: "unsupported", reason: "missing_versioned_context" };
  }
  const indexByTarget = new Map(documents.map(({ document }, index) => [targetKey(document), index]));
  if (indexByTarget.size !== documents.length) return { status: "unsupported", reason: "duplicate_targets" };
  let checked = 0;
  let change: Extract<NormalizationVerification, { status: "changed" }> | undefined;
  for (const [index, source] of documents.entries()) {
    const after = afterDocuments[index]!;
    const { siteId, pageId, locale, revision } = source.document;
    const target = { siteId, pageId, locale, revision };
    try {
      const left = resolvePageDocument(source.document, input.components, input.blocks, input.siteStyles).document;
      const right = resolvePageDocument(after, input.components, input.blocks, input.siteStyles).document;
      const difference = documentDifference(left, right);
      if (difference) change ??= { status: "changed", target, ...difference };
      checked++;
      if (!source.presentation) continue;
      const presentation = parseSitePresentation(source.presentation, left, input.blocks);
      // The same validated presentation snapshot supplies styles to both sides.
      parsePageDocument(presentationLayoutDocument(presentation), input.blocks);
      checked++;
      const composed = [presentation.shared.header, presentation.shared.footer, ...(presentation.overlays ?? []).map(({ document }) => document),
        ...(presentation.hostViews ?? []).map(({ document }) => document)];
      for (const before of composed) {
        // The selected page occupies the matching shared slot when it is being
        // edited directly. Its resolved inputs were already compared above.
        if (targetKey(before) === targetKey(source.document)) continue;
        const candidateIndex = indexByTarget.get(targetKey(before));
        let candidate = before;
        if (candidateIndex !== undefined) {
          const original = documents[candidateIndex]!.document;
          if (original.revision !== before.revision) return { status: "unsupported", target, reason: "ambiguous_presentation_document" };
          const expected = parsePageDocument(original, input.blocks);
          if (normalizationKey(expected) !== normalizationKey(before)) return { status: "unsupported", target, reason: "ambiguous_presentation_document" };
          candidate = afterDocuments[candidateIndex]!;
        }
        // The renderer builds each embedded snapshot with its own tokens/styles.
        const candidateDocument = parsePageDocument(candidate, input.blocks);
        const embeddedDifference = documentDifference(before, candidateDocument);
        if (embeddedDifference) change ??= { status: "changed", target, ...embeddedDifference };
        checked++;
      }
    } catch {
      return { status: "unsupported", target, reason: "invalid_or_incomplete_rendering_context" };
    }
  }
  return change ?? { status: "equivalent", documentsChecked: checked };
}
