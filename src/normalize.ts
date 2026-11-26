import { expandDocument, instancesOf } from "./component-expand.js";
import { PAGE_NODE_NAME_MAX_LENGTH } from "./document.js";
import { PAGE_OPERATION_LIMIT, pageOperationWire, parsePageOperation, type PageOperationWire } from "./editing-page-operations.js";
import { editDocumentById, inheritedStyle, walkNodes, type EditorOperationBlocks, type EditorOperationById } from "./editor-model.js";
import type { EditorBreakpointSettings, EditorBreakpointSettingsSnapshot, EditorLock } from "./editor-types.js";
import { normalizationKey, verifyNormalization } from "./normalize-verify.js";
import { parseSiteStyles, resolvePageStyles, type SiteStyles, type SiteStylesRevision } from "./site-styles.js";
import { colorParts, removeBreakpointSetting } from "./style-model.js";
import { declarationCss, isStyleProperty, stateNames, styleTokenKind, textStyleProperties, tokenCssValue } from "./style-values.js";
import type {
  ComponentLibrary, NodeStyle, PageDocument, PageNode, SitePresentation, StateName,
  StateProperty, StyleDeclarations, StyleProperty, StyleValue, TextStyle, TextStyleDeclarations
} from "./types.js";

export { verifyNormalization } from "./normalize-verify.js";
export type { PageOperationWire } from "./editing-page-operations.js";

export type NormalizationDocument = {
  readonly document: PageDocument;
  readonly version?: string;
  readonly componentsVersion?: string;
  readonly presentationVersion?: string;
  readonly presentation?: SitePresentation;
  readonly locks?: readonly EditorLock[];
};

export type NormalizationInput = {
  readonly documents: readonly (PageDocument | NormalizationDocument)[];
  readonly siteStyles?: SiteStyles;
  readonly siteStylesRevision?: SiteStylesRevision;
  readonly components?: ComponentLibrary;
  /** Opaque component-library version paired with `components`, when page snapshots declare one. */
  readonly componentsVersion?: string;
  readonly blocks?: EditorOperationBlocks;
  readonly breakpoints?: readonly number[];
  readonly breakpointSettings?: EditorBreakpointSettingsSnapshot;
};

export type NormalizationTarget = Pick<PageDocument, "siteId" | "pageId" | "locale" | "revision">
  & Pick<NormalizationDocument, "version" | "componentsVersion" | "presentationVersion">;
type NodeLocation = { readonly target: NormalizationTarget; readonly nodeId: string };
type DeclarationLocation = NodeLocation & { readonly slot?: string } & (
  { readonly breakpoint: number | "base"; readonly state?: never }
  | { readonly breakpoint?: never; readonly state: StateName }
);
type ColorOccurrence = DeclarationLocation & { readonly property: StyleProperty };
type RedundantOverride = NodeLocation & { readonly slot?: string; readonly breakpoint: number; readonly property: StyleProperty; readonly value: StyleValue };
type TextGroup = { readonly style: TextStyle; readonly nodes: readonly NodeLocation[] };
type SectionName = NodeLocation & { readonly name: string; readonly path: readonly number[]; readonly descendants: number };

export type NormalizationAnalysis = {
  readonly targets: readonly NormalizationTarget[];
  readonly siteStylesRevision?: SiteStylesRevision;
  readonly elements: number;
  readonly colors: readonly { readonly value: string; readonly count: number; readonly occurrences: readonly ColorOccurrence[] }[];
  readonly textCombinations: readonly { readonly values: TextStyleDeclarations; readonly count: number }[];
  readonly textStyleGroups: readonly TextGroup[];
  readonly redundantOverrides: readonly RedundantOverride[];
  readonly breakpoints: readonly { readonly minWidth: number; readonly uses: number; readonly configured: boolean }[];
  readonly unusedBreakpoints: readonly number[];
  readonly nearbyBreakpoints: readonly { readonly from: number; readonly into: number }[];
  readonly sectionNames: readonly SectionName[];
};

export type NormalizationClassification = "lossless" | "semantic change" | "lossy";
export type NormalizationSiteSettingsChange = {
  readonly siteId: string;
  readonly action: "remove-breakpoint" | "merge-breakpoints";
  readonly minWidth: number;
  readonly into?: number;
  readonly expectedVersion?: string;
  readonly settings?: EditorBreakpointSettings;
};

type OperationProposal = {
  readonly id: string;
  readonly kind: "color-token" | "text-style" | "redundant-overrides" | "merge-breakpoints";
  readonly classification: NormalizationClassification;
  readonly target: NormalizationTarget;
  readonly operations: readonly PageOperationWire[];
};

export type NormalizationProposal = OperationProposal
  | { readonly id: string; readonly kind: "section-name"; readonly classification: "semantic change"; readonly suggestion: SectionName }
  | { readonly id: string; readonly kind: "remove-breakpoint" | "merge-breakpoints"; readonly classification: "lossy"; readonly siteSettingsChanges: readonly NormalizationSiteSettingsChange[] };

export type NormalizationPlan = {
  readonly targets: readonly NormalizationTarget[];
  readonly siteStylesRevision?: SiteStylesRevision;
  readonly proposals: readonly NormalizationProposal[];
};

export type NormalizationOperationBatch = {
  readonly target: NormalizationTarget;
  readonly proposalIds: readonly string[];
  /** JSON wire format. Deletions in property maps are encoded as null. */
  readonly operations: readonly PageOperationWire[];
};

export type NormalizationVerification =
  | { readonly status: "equivalent"; readonly documentsChecked: number }
  | { readonly status: "changed"; readonly target: NormalizationTarget; readonly reason: string; readonly nodeId?: string;
      readonly slot?: string; readonly width?: number; readonly states?: readonly StateName[] }
  | { readonly status: "unsupported"; readonly reason: string; readonly target?: NormalizationTarget };

export type NormalizationLintCode = "literal-matches-token" | "redundant-override" | "unnamed-large-section" | "unused-token" | "unused-breakpoint";
export type NormalizationLintFinding = {
  readonly code: NormalizationLintCode;
  readonly target?: Pick<PageDocument, "siteId" | "pageId" | "locale">;
  readonly nodeId?: string;
  readonly slot?: string;
  readonly breakpoint?: number | "base";
  readonly state?: StateName;
  readonly property?: StyleProperty;
  readonly tokenName?: string;
  readonly textStyleName?: string;
  readonly suggestion?: string;
  readonly message: string;
};
/** Optional site-wide context used by lint rules that depend on configured responsive tiers. */
export type NormalizationLintContext = SiteStyles & {
  readonly breakpoints?: readonly number[];
  readonly breakpointSettings?: EditorBreakpointSettingsSnapshot;
};

const nearbyDistance = 48;
const largeSectionDescendants = 8;
const typographyProperties = ["fontFamily", "fontSize", "lineHeight", "letterSpacing"] as const;

function targetOf(source: NormalizationDocument): NormalizationTarget {
  const { siteId, pageId, locale, revision } = source.document;
  const presentationVersion = source.presentationVersion ?? source.presentation?.version;
  return { siteId, pageId, locale, revision,
    ...(source.version === undefined ? {} : { version: source.version }),
    ...(source.componentsVersion === undefined ? {} : { componentsVersion: source.componentsVersion }),
    ...(presentationVersion === undefined ? {} : { presentationVersion }) };
}
const identity = ({ siteId, pageId, locale }: NormalizationTarget) => JSON.stringify([siteId, pageId, locale]);
const sortText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const numericSort = (a: number, b: number) => a - b;
const proposalId = (...parts: (string | number)[]) => parts.map((part) => encodeURIComponent(part)).join(":");

function sourcesOf(input: NormalizationInput): NormalizationDocument[] {
  const sources = input.documents.map((entry) => "document" in entry ? entry : { document: entry });
  const identities = sources.map((source) => identity(targetOf(source)));
  if (new Set(identities).size !== identities.length) throw new Error("正規化の対象ページが重複しています。");
  if (new Set(sources.map(({ document }) => document.siteId)).size > 1) throw new Error("共通スタイルと同じサイトの文書を指定してください。");
  return sources;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function nodeStyles(node: Exclude<PageNode, { type: "text" }>): [string | undefined, NodeStyle][] {
  return [...(node.style ? [[undefined, node.style] as [undefined, NodeStyle]] : []),
    ...(node.type === "component" ? Object.entries(node.slots ?? {}).sort(([a], [b]) => sortText(a, b)) : [])];
}

function collectUsage(document: Pick<PageDocument, "body" | "textStyles">, usage: Map<number, number>): void {
  const use = (width: number) => usage.set(width, (usage.get(width) ?? 0) + 1);
  function visit(nodes: readonly PageNode[]): void {
    for (const node of nodes) {
      if (node.type === "text") continue;
      for (const [, style] of nodeStyles(node)) {
        for (const { minWidth } of style.responsive ?? []) use(minWidth);
        for (const { minWidth, maxWidth } of style.hidden ?? []) {
          if (minWidth > 0) use(minWidth);
          if (maxWidth !== undefined) use(maxWidth + 1);
        }
      }
      if (node.type === "element") visit(node.children);
    }
  }
  for (const style of Object.values(document.textStyles ?? {})) for (const { minWidth } of style.responsive ?? []) use(minWidth);
  visit(document.body);
}

function textProperties(values: StyleDeclarations | undefined): TextStyleDeclarations {
  const result: TextStyleDeclarations = {};
  for (const property of textStyleProperties) {
    const value = values?.[property];
    if (value !== undefined) result[property] = value;
  }
  return result;
}
function textStyleOf(style: NodeStyle): TextStyle {
  const responsive = (style.responsive ?? []).map(({ minWidth, declarations }) => ({ minWidth, declarations: textProperties(declarations) }))
    .filter(({ declarations }) => Object.keys(declarations).length);
  return { base: textProperties(style.base), ...(responsive.length ? { responsive } : {}) };
}

function hasContent(values: object): boolean { return Object.keys(values).length > 0; }
function sameValue(a: StyleValue, b: StyleValue | undefined): boolean {
  return a === b || typeof a === "object" && typeof b === "object" && a.token === b.token;
}
function normalizeHexColor(value: string): string | undefined {
  if (!colorParts(value)) return undefined;
  const digits = value.slice(1).toLowerCase();
  const expanded = digits.length === 3 || digits.length === 4 ? [...digits].map((digit) => digit + digit).join("") : digits;
  return `#${expanded}`;
}

export function analyzeNormalization(input: NormalizationInput): NormalizationAnalysis {
  const sources = sourcesOf(input).sort((a, b) => sortText(identity(a.document), identity(b.document)));
  const site = parseSiteStyles(input.siteStyles ?? {});
  const colors = new Map<string, ColorOccurrence[]>(), combinations = new Map<string, { values: TextStyleDeclarations; count: number }>();
  const textGroups = new Map<string, { style: TextStyle; nodes: NodeLocation[] }>(), usage = new Map<number, number>();
  const redundantOverrides: RedundantOverride[] = [], sectionNames: SectionName[] = [];
  const usageReferences = new Set<PageDocument>();
  let elements = 0;
  const countDocument = (document: PageDocument) => {
    if (!usageReferences.has(document)) {
      usageReferences.add(document);
      collectUsage(document, usage);
    }
  };
  collectUsage({ body: input.components?.components.map(({ root }) => root) ?? [], ...(site.textStyles ? { textStyles: site.textStyles } : {}) }, usage);

  for (const source of sources) {
    const target = targetOf(source), document = source.document;
    const effective = resolvePageStyles(document, site);
    const expandedInstances = new Map<string, Exclude<PageNode, { type: "text" }>>();
    if (input.components && instancesOf(document.body).length) {
      try {
        const expanded = expandDocument(effective, input.components);
        for (const { node } of walkNodes(expanded.document)) {
          if (node.type !== "text" && expanded.origins.get(node.id)?.instance === node.id) expandedInstances.set(node.id, node);
        }
      } catch {
        // Analyze authored nodes when component context is incomplete.
      }
    }
    countDocument(document);
    if (source.presentation) {
      const { shared, overlays, hostViews, layout } = source.presentation;
      countDocument(shared.header);
      countDocument(shared.footer);
      for (const entry of [...overlays ?? [], ...hostViews ?? []]) countDocument(entry.document);
      if (layout) collectUsage({ body: [{ type: "element", tag: "div", id: "layout", style: layout, children: [] }] }, usage);
    }

    const trackColor = (location: DeclarationLocation, values: StyleDeclarations | undefined) => {
      for (const property of Object.keys(values ?? {}).filter(isStyleProperty).sort(sortText)) {
        const value = values?.[property];
        if (styleTokenKind(property) === "color" && typeof value === "string") {
          const normalized = normalizeHexColor(value);
          if (normalized) pushTo(colors, normalized, { ...location, property });
        }
      }
    };

    function visit(node: PageNode, path: number[]): { count: number; heading?: string; text: string } {
      if (node.type === "text") return { count: 0, text: node.text };
      elements++;
      const location = { target, nodeId: node.id };
      for (const [slot, style] of nodeStyles(node)) {
        const declarationTarget = { ...location, ...(slot === undefined ? {} : { slot }) };
        trackColor({ ...declarationTarget, breakpoint: "base" }, style.base);
        if (slot === undefined) for (const state of stateNames) trackColor({ ...declarationTarget, state }, style.states?.[state]);
        for (const { minWidth, declarations } of style.responsive ?? []) {
          trackColor({ ...declarationTarget, breakpoint: minWidth }, declarations);
          for (const property of Object.keys(declarations).filter(isStyleProperty).sort(sortText)) {
            const value = declarations[property]!;
            const styledNode = slot !== undefined ? { ...node, style } : expandedInstances.get(node.id) ?? node;
            const inherited = inheritedStyle(effective, styledNode, property, minWidth)?.value;
            if (sameValue(value, inherited)) redundantOverrides.push({ ...declarationTarget, breakpoint: minWidth, property, value });
          }
        }
      }
      if (node.type !== "element") return { count: 1, text: "" };
      if (node.style) {
        const reference = node.style.textStyle ? effective.textStyles?.[node.style.textStyle] : undefined;
        const own = new Map<number, StyleDeclarations | undefined>([[0, node.style.base]]);
        for (const { minWidth, declarations } of node.style.responsive ?? []) own.set(minWidth, declarations);
        const widths = new Set([...own.keys(), ...(reference?.responsive ?? []).map(({ minWidth }) => minWidth)]);
        const seen = new Set<string>();
        for (const width of widths) {
          const sample = Object.fromEntries(typographyProperties.flatMap((property) => {
            const value = own.get(width)?.[property] ?? inheritedStyle(effective, node, property, width)?.value;
            return value === undefined ? [] : [[property, value]];
          })) as TextStyleDeclarations;
          if (!hasContent(sample)) continue;
          const key = normalizationKey(sample);
          if (seen.has(key)) continue;
          seen.add(key);
          combinations.set(key, { values: sample, count: (combinations.get(key)?.count ?? 0) + 1 });
        }
        if (!node.style.textStyle) {
          const style = textStyleOf(node.style);
          if (hasContent(style.base) || style.responsive?.length) {
            const key = normalizationKey(style), group = textGroups.get(key);
            if (group) group.nodes.push(location);
            else textGroups.set(key, { style, nodes: [location] });
          }
        }
      }
      let descendants = 0, heading: string | undefined, text = "";
      for (const [index, child] of node.children.entries()) {
        const found = visit(child, [...path, index]);
        descendants += found.count;
        heading ??= found.heading;
        if (text.length < 2 * PAGE_NODE_NAME_MAX_LENGTH) text += found.text.slice(0, 2 * PAGE_NODE_NAME_MAX_LENGTH - text.length);
      }
      if (/^h[1-6]$/u.test(node.tag) && text.trim()) heading = text;
      const section = ["section", "article", "header", "footer", "main", "nav", "aside"].includes(node.tag)
        || node.tag === "div" && path.length === 1;
      if (section && !node.name && descendants >= largeSectionDescendants) {
        const cleaned = heading?.replace(/[\u0000-\u001f\u007f-\u009f\s]+/gu, " ").trim();
        const name = cleaned ? [...cleaned].slice(0, PAGE_NODE_NAME_MAX_LENGTH).join("").trimEnd()
          : `セクション ${path.map((index) => index + 1).join(".")}`;
        sectionNames.push({ ...location, name, path, descendants });
      }
      return { count: descendants + 1, text, ...(heading === undefined ? {} : { heading }) };
    }
    document.body.forEach((node, index) => visit(node, [index]));
  }
  const configured = new Set([...(input.breakpoints ?? []), ...(input.breakpointSettings?.settings.breakpoints.map(({ minWidth }) => minWidth) ?? [])]);
  if ([...configured].some((width) => !Number.isInteger(width) || width < 320 || width > 3840)) throw new Error("表示幅の段は 320〜3840px の整数で指定してください。");
  const widths = [...new Set([...configured, ...[...usage.keys()].filter((width) => width >= 320 && width <= 3840)])].sort(numericSort);
  const nearbyBreakpoints = widths.slice(1).flatMap((from, index) => {
    const into = widths[index]!;
    return from - into <= nearbyDistance ? [{ from, into }] : [];
  });
  return {
    targets: sources.map(targetOf),
    ...(input.siteStylesRevision ? { siteStylesRevision: { ...input.siteStylesRevision } } : {}),
    elements,
    colors: [...colors].sort(([a], [b]) => sortText(a, b)).map(([value, occurrences]) => ({ value, count: occurrences.length, occurrences })),
    textCombinations: [...combinations].sort(([a], [b]) => sortText(a, b)).map(([, group]) => group),
    textStyleGroups: [...textGroups].sort(([a], [b]) => sortText(a, b)).map(([, group]) => group).filter(({ nodes }) => nodes.length > 1),
    redundantOverrides,
    breakpoints: widths.map((minWidth) => ({ minWidth, uses: usage.get(minWidth) ?? 0, configured: configured.has(minWidth) })),
    unusedBreakpoints: [...configured].filter((width) => !usage.get(width)).sort(numericSort),
    nearbyBreakpoints,
    sectionNames
  };
}

function lintSiteStyles(context: NormalizationLintContext): SiteStyles {
  return parseSiteStyles({ ...(context.tokens ? { tokens: context.tokens } : {}), ...(context.textStyles ? { textStyles: context.textStyles } : {}) });
}

function collectTokenReferences(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) { value.forEach((entry) => collectTokenReferences(entry, into)); return; }
  if (!value || typeof value !== "object") return;
  if ("token" in value && typeof value.token === "string") { into.add(value.token); return; }
  Object.values(value).forEach((entry) => collectTokenReferences(entry, into));
}

function matchesTokenLiteral(property: StyleProperty, value: unknown, token: NonNullable<SiteStyles["tokens"]>[string]): boolean {
  if ((typeof value !== "string" && typeof value !== "number") || token.type !== styleTokenKind(property)) return false;
  const tokenValue = tokenCssValue(token);
  if (styleTokenKind(property) === "color") return normalizeHexColor(String(value)) === normalizeHexColor(tokenValue);
  try { return declarationCss(property, value as StyleValue) === declarationCss(property, tokenValue); }
  catch { return false; }
}

function lintDeclarationValues(
  declarations: StyleDeclarations | undefined,
  tokens: NonNullable<SiteStyles["tokens"]>,
  target: Pick<PageDocument, "siteId" | "pageId" | "locale">,
  finding: Pick<NormalizationLintFinding, "nodeId" | "slot" | "breakpoint" | "state" | "textStyleName">
): NormalizationLintFinding[] {
  if (!declarations) return [];
  const findings: NormalizationLintFinding[] = [];
  for (const [name, value] of Object.entries(declarations)) {
    if (!isStyleProperty(name) || value === undefined || typeof value === "object") continue;
    const property = name as StyleProperty;
    for (const [tokenName, token] of Object.entries(tokens).sort(([a], [b]) => sortText(a, b))) {
      if (!matchesTokenLiteral(property, value, token)) continue;
      findings.push({ code: "literal-matches-token", target, ...finding, property, tokenName,
        message: `${property} の値は共通token「${tokenName}」と同じです。token参照に置き換えてください。` });
    }
  }
  return findings;
}

function lintFindingOrder(a: NormalizationLintFinding, b: NormalizationLintFinding): number {
  const left = [a.code, a.target ? identity({ ...a.target, revision: 0 }) : "", a.nodeId ?? "", a.slot ?? "", String(a.breakpoint ?? ""), a.state ?? "", a.property ?? "", a.tokenName ?? ""];
  const right = [b.code, b.target ? identity({ ...b.target, revision: 0 }) : "", b.nodeId ?? "", b.slot ?? "", String(b.breakpoint ?? ""), b.state ?? "", b.property ?? "", b.tokenName ?? ""];
  for (let index = 0; index < left.length; index++) {
    const order = sortText(left[index]!, right[index]!);
    if (order) return order;
  }
  return 0;
}

/** Lint one or more documents with the same override, section, token, and breakpoint rules used by analyzeNormalization. */
export function lintDocuments(documents: readonly PageDocument[], context: NormalizationLintContext = {}): NormalizationLintFinding[] {
  const siteStyles = lintSiteStyles(context);
  const input: NormalizationInput = { documents, siteStyles,
    ...(context.breakpointSettings ? { breakpointSettings: context.breakpointSettings } : {}),
    ...(context.breakpoints ? { breakpoints: context.breakpoints } : {}) };
  const analysis = analyzeNormalization(input), findings: NormalizationLintFinding[] = [];
  for (const document of documents) {
    const target = { siteId: document.siteId, pageId: document.pageId, locale: document.locale };
    const effective = resolvePageStyles(document, siteStyles), tokens = effective.tokens;
    const usedTokens = new Set<string>();
    collectTokenReferences({ body: document.body, textStyles: document.textStyles }, usedTokens);
    for (const tokenName of Object.keys(document.tokens).sort(sortText)) if (!usedTokens.has(tokenName)) {
      findings.push({ code: "unused-token", target, tokenName, message: `文書token「${tokenName}」は本文・文字スタイルから参照されていません。` });
    }

    const addStyle = (nodeId: string, style: NodeStyle, slot?: string) => {
      const location = { nodeId, ...(slot === undefined ? {} : { slot }) };
      findings.push(...lintDeclarationValues(style.base, tokens, target, { ...location, breakpoint: "base" }));
      for (const [state, declarations] of Object.entries(style.states ?? {})) {
        findings.push(...lintDeclarationValues(declarations, tokens, target, { ...location, state: state as StateName }));
      }
      for (const tier of style.responsive ?? []) findings.push(...lintDeclarationValues(tier.declarations, tokens, target, { ...location, breakpoint: tier.minWidth }));
    };
    for (const { node } of walkNodes(document)) {
      if (node.type === "text") continue;
      if (node.style) addStyle(node.id, node.style);
      if (node.type === "component") for (const [slot, style] of Object.entries(node.slots ?? {})) addStyle(node.id, style, slot);
    }
    for (const [textStyleName, style] of Object.entries(document.textStyles ?? {})) {
      findings.push(...lintDeclarationValues(style.base, tokens, target, { textStyleName, breakpoint: "base" }));
      for (const tier of style.responsive ?? []) findings.push(...lintDeclarationValues(tier.declarations, tokens, target, { textStyleName, breakpoint: tier.minWidth }));
    }
  }
  for (const entry of analysis.redundantOverrides) findings.push({ code: "redundant-override",
    target: { siteId: entry.target.siteId, pageId: entry.target.pageId, locale: entry.target.locale }, nodeId: entry.nodeId,
    ...(entry.slot === undefined ? {} : { slot: entry.slot }), breakpoint: entry.breakpoint, property: entry.property,
    message: `${entry.breakpoint}px の ${entry.property} は継承値と同じため削除できます。` });
  for (const entry of analysis.sectionNames) findings.push({ code: "unnamed-large-section",
    target: { siteId: entry.target.siteId, pageId: entry.target.pageId, locale: entry.target.locale }, nodeId: entry.nodeId,
    suggestion: entry.name, message: `大きなsectionに名前がありません。「${entry.name}」を候補にできます。` });
  for (const breakpoint of analysis.unusedBreakpoints) findings.push({ code: "unused-breakpoint", breakpoint,
    message: `${breakpoint}px の表示幅は文書・共通文字スタイルから参照されていません。` });
  return findings.sort(lintFindingOrder);
}

/** Lint one document. Supply configured breakpoints in `siteStyles.breakpointSettings` or `siteStyles.breakpoints`. */
export function lintDocument(document: PageDocument, siteStyles: NormalizationLintContext = {}): NormalizationLintFinding[] {
  return lintDocuments([document], siteStyles);
}

export function decodeNormalizationOperations(operations: readonly PageOperationWire[]): EditorOperationById[] {
  return operations.map((operation, index) => parsePageOperation(operation, `$.operations[${index}]`));
}

function alias(names: Set<string>, prefix: string): string {
  let name = prefix, serial = 2;
  while (names.has(name)) name = `${prefix}-${serial++}`;
  names.add(name);
  return name;
}

function colorOperations(name: string, value: string, occurrences: readonly ColorOccurrence[]): EditorOperationById[] {
  const result: EditorOperationById[] = [{ type: "token", name, token: { type: "color", value } }];
  const ref = { token: name };
  const groups = new Map<string, EditorOperationById & { values: Partial<Record<StyleProperty, StyleValue>> }>();
  for (const { breakpoint, state, slot, nodeId, property } of occurrences) {
    if (slot !== undefined && breakpoint !== undefined) {
      result.push({ type: "slotStyle", nodeId, slot, breakpoint, property, value: ref });
      continue;
    }
    const key = JSON.stringify([nodeId, breakpoint, state]);
    const previous = groups.get(key);
    if (previous) {
      previous.values[property] = ref;
      continue;
    }
    const operation = state === undefined
      ? { type: "styles" as const, nodeId, breakpoint: breakpoint!, values: { [property]: ref } }
      : { type: "state" as const, nodeId, state, values: { [property as StateProperty]: ref } };
    groups.set(key, operation);
    result.push(operation);
  }
  return result;
}

function textOperations(name: string, style: TextStyle, nodes: readonly NodeLocation[]): EditorOperationById[] {
  const remove = (values: TextStyleDeclarations) => Object.fromEntries(Object.keys(values).map((property) => [property, undefined]));
  const previous = { ...style.base };
  const responsive: NonNullable<TextStyle["responsive"]> = [];
  for (const { minWidth, declarations } of style.responsive ?? []) {
    const values: TextStyleDeclarations = {};
    for (const property of textStyleProperties) {
      const value = declarations[property];
      if (value !== undefined && !sameValue(value, previous[property])) {
        values[property] = value;
        previous[property] = value;
      }
    }
    if (hasContent(values)) responsive.push({ minWidth, declarations: values });
  }
  return [{ type: "textStyle", name, style: { base: style.base, ...(responsive.length ? { responsive } : {}) } }, ...nodes.flatMap(({ nodeId }): EditorOperationById[] => [
    { type: "nodeTextStyle", nodeId, name },
    ...(hasContent(style.base) ? [{ type: "styles" as const, nodeId, breakpoint: "base" as const, values: remove(style.base) }] : []),
    ...(style.responsive ?? []).map(({ minWidth, declarations }) => ({ type: "styles" as const, nodeId, breakpoint: minWidth, values: remove(declarations) }))
  ])];
}

function redundantOperations(overrides: readonly RedundantOverride[]): EditorOperationById[] {
  const result: EditorOperationById[] = [];
  const perRule = new Map<string, Partial<Record<StyleProperty, undefined>>>();
  for (const { nodeId, breakpoint, property, slot } of overrides) {
    if (slot !== undefined) result.push({ type: "slotStyle", nodeId, slot, breakpoint, property, value: undefined });
    else {
      const key = JSON.stringify([nodeId, breakpoint]);
      const values = perRule.get(key) ?? {};
      values[property] = undefined;
      if (!perRule.has(key)) {
        perRule.set(key, values);
        result.push({ type: "styles", nodeId, breakpoint, values });
      }
    }
  }
  return result;
}

function applyOperations(source: NormalizationDocument, operations: readonly EditorOperationById[], input: NormalizationInput): PageDocument {
  return operations.reduce((document, operation) => editDocumentById(document, operation, input.blocks, source.locks, input.components, input.siteStyles), source.document);
}

function mergeOperations(document: PageDocument, from: number, into: number): EditorOperationById[] | undefined {
  const operations: EditorOperationById[] = [];
  const visit = (nodes: readonly PageNode[]): boolean => {
    for (const node of nodes) {
      if (node.type === "text") continue;
      for (const [slot, style] of nodeStyles(node)) {
        if (style.hidden?.some(({ minWidth, maxWidth }) => minWidth === from || maxWidth === from - 1)) return false;
        const declarations = style.responsive?.find(({ minWidth }) => minWidth === from)?.declarations;
        if (!declarations) continue;
        if (declarations.backgroundImage !== undefined) return false;
        // Remove first so the operation also works on a node at its tier limit.
        const properties = Object.keys(declarations).filter(isStyleProperty).sort(sortText);
        if (slot === undefined) {
          operations.push({ type: "styles", nodeId: node.id, breakpoint: from, values: Object.fromEntries(properties.map((property) => [property, undefined])) });
          operations.push({ type: "styles", nodeId: node.id, breakpoint: into, values: declarations });
        } else {
          for (const property of properties) operations.push({ type: "slotStyle", nodeId: node.id, slot, breakpoint: from, property, value: undefined });
          for (const property of properties) operations.push({ type: "slotStyle", nodeId: node.id, slot, breakpoint: into, property, value: declarations[property] });
        }
      }
      if (node.type === "element" && !visit(node.children)) return false;
    }
    return true;
  };
  if (!visit(document.body)) return undefined;
  for (const [name, style] of Object.entries(document.textStyles ?? {}).sort(([a], [b]) => sortText(a, b))) {
    const moved = style.responsive?.find(({ minWidth }) => minWidth === from);
    if (!moved) continue;
    const previous = style.responsive?.find(({ minWidth }) => minWidth === into);
    const responsive = [...style.responsive!.filter(({ minWidth }) => minWidth !== from && minWidth !== into),
      { minWidth: into, declarations: { ...previous?.declarations, ...moved.declarations } }].sort((a, b) => a.minWidth - b.minWidth);
    operations.push({ type: "textStyle", name, style: { ...style, responsive } });
  }
  return operations;
}

function settingChange(input: NormalizationInput, siteId: string, minWidth: number, into?: number): NormalizationSiteSettingsChange {
  const snapshot = input.breakpointSettings;
  const entry = snapshot?.settings.breakpoints.find((breakpoint) => breakpoint.minWidth === minWidth);
  const settings = snapshot && entry && entry.name !== "PC" ? removeBreakpointSetting(snapshot.settings, entry.name) : undefined;
  return { siteId, action: into === undefined ? "remove-breakpoint" : "merge-breakpoints", minWidth,
    ...(into === undefined ? {} : { into }),
    ...(snapshot ? { expectedVersion: snapshot.version } : {}),
    ...(settings ? { settings } : {}) };
}

export function planNormalization(input: NormalizationInput): NormalizationPlan {
  const analysis = analyzeNormalization(input), sources = sourcesOf(input);
  const before = sources.map(({ document }) => document), site = input.siteStyles ?? {};
  const proposals: NormalizationProposal[] = [];
  for (const target of analysis.targets) {
    const documentKey = identity(target), index = sources.findIndex(({ document }) => identity(document) === documentKey);
    const source = sources[index]!;
    const { document } = source;
    const tokens = new Set([...Object.keys(document.tokens), ...Object.keys(site.tokens ?? {}), ...Object.keys(input.components?.tokens ?? {})]);
    const styleNames = new Set([...Object.keys(document.textStyles ?? {}), ...Object.keys(site.textStyles ?? {})]);
    const check = (classification: NormalizationClassification, operations: readonly EditorOperationById[]): boolean => {
      try {
        const next = applyOperations(source, operations, input);
        if (classification === "lossless") {
          const after = before.map((original, position) => position === index ? next : original);
          return verifyNormalization(input, after).status === "equivalent";
        }
        return true;
      } catch {
        return false;
      }
    };
    const addProposal = (kind: OperationProposal["kind"], classification: NormalizationClassification, detail: string,
      operations: EditorOperationById[], checked = false) => {
      if (operations.length === 0 || !checked && !check(classification, operations)) return;
      const id = proposalId(kind, target.siteId, target.pageId, target.locale, detail);
      proposals.push({ id, kind, classification, target, operations: operations.map(pageOperationWire) });
    };
    const atTarget = <T extends { target: NormalizationTarget }>(entries: readonly T[]) => entries.filter((entry) => identity(entry.target) === documentKey);
    for (const group of analysis.colors) {
      const occurrences = atTarget(group.occurrences);
      if (occurrences.length < 2 || tokens.size >= 128) continue;
      const name = alias(tokens, `color-${group.value.toLowerCase().replace(/^#/u, "")}`);
      addProposal("color-token", "semantic change", group.value, colorOperations(name, group.value, occurrences));
    }
    for (const group of analysis.textStyleGroups) {
      const nodes = atTarget(group.nodes);
      if (nodes.length < 2 || styleNames.size >= 64) continue;
      const name = alias(styleNames, "text-style");
      addProposal("text-style", "lossless", name, textOperations(name, group.style, nodes));
    }
    const redundant = atTarget(analysis.redundantOverrides);
    if (redundant.length) {
      const all = redundantOperations(redundant);
      if (check("lossless", all)) addProposal("redundant-overrides", "lossless", "all", all, true);
      else {
        const safe = redundant.filter((candidate) => check("lossless", redundantOperations([candidate])));
        addProposal("redundant-overrides", "lossless", "all", redundantOperations(safe));
      }
    }
    const componentWidths = new Map<number, number>(), ownedWidths = new Map<number, number>();
    let hasComponentContext = true;
    if (instancesOf(document.body).length) {
      try {
        if (!input.components || source.componentsVersion !== undefined && source.componentsVersion !== input.componentsVersion) hasComponentContext = false;
        else {
          collectUsage(expandDocument(resolvePageStyles(document, site), input.components).document, componentWidths);
          collectUsage(document, ownedWidths);
        }
      } catch {
        hasComponentContext = false;
      }
    }
    for (const { from, into } of analysis.nearbyBreakpoints) {
      // The authored width may also occur inside component masters or site texts,
      // which are separate editing targets. Avoid claiming to merge their rules.
      if (!hasComponentContext || (componentWidths.get(from) ?? 0) > (ownedWidths.get(from) ?? 0)) continue;
      const operations = mergeOperations(document, from, into);
      if (operations) addProposal("merge-breakpoints", "lossy", `${from}/${into}`, operations);
    }
    for (const suggestion of atTarget(analysis.sectionNames)) {
      proposals.push({ id: proposalId("section-name", target.siteId, target.pageId, target.locale, suggestion.nodeId),
        kind: "section-name", classification: "semantic change", suggestion });
    }
  }

  const siteId = analysis.targets[0]?.siteId;
  if (siteId) {
    const configured = new Set(analysis.breakpoints.filter(({ configured }) => configured).map(({ minWidth }) => minWidth));
    const pcWidth = input.breakpointSettings?.settings.breakpoints.find(({ name }) => name === "PC")?.minWidth;
    for (const width of analysis.unusedBreakpoints) if (width !== pcWidth) proposals.push({
      id: proposalId("remove-breakpoint", siteId, width), kind: "remove-breakpoint", classification: "lossy",
      siteSettingsChanges: [settingChange(input, siteId, width)]
    });
    for (const { from, into } of analysis.nearbyBreakpoints) if (from !== pcWidth && configured.has(from) && configured.has(into)) proposals.push({
      id: proposalId("merge-breakpoints", siteId, from, into), kind: "merge-breakpoints", classification: "lossy",
      siteSettingsChanges: [settingChange(input, siteId, from, into)]
    });
  }
  return { targets: analysis.targets, ...(analysis.siteStylesRevision ? { siteStylesRevision: analysis.siteStylesRevision } : {}), proposals };
}

export type NormalizationSelection = { readonly approvedProposalIds?: readonly string[]; readonly includeLossless?: boolean };

export function selectNormalizationOperations(plan: NormalizationPlan, selection: NormalizationSelection = {}): NormalizationOperationBatch[] {
  const approved = new Set(selection.approvedProposalIds ?? []);
  const known = new Set(plan.proposals.map(({ id }) => id));
  if ([...approved].some((id) => !known.has(id))) throw new Error("正規化の承認対象が計画にありません。");
  const batches = new Map<string, { target: NormalizationTarget; proposalIds: string[]; operations: PageOperationWire[]; merge: boolean }>();
  for (const proposal of plan.proposals) {
    if (!("operations" in proposal) || !approved.has(proposal.id) && !(proposal.classification === "lossless" && selection.includeLossless !== false)) continue;
    const key = identity(proposal.target);
    const batch = batches.get(key) ?? { target: proposal.target, proposalIds: [], operations: [], merge: false };
    const merge = proposal.kind === "merge-breakpoints";
    if (batch.merge || merge && batch.operations.length) throw new Error("表示幅の段の統合は、そのページの他の正規化操作と同時に適用できません。");
    batch.merge = merge;
    batch.proposalIds.push(proposal.id);
    batch.operations.push(...proposal.operations);
    if (batch.operations.length > PAGE_OPERATION_LIMIT) throw new Error(`1ページの正規化操作は ${PAGE_OPERATION_LIMIT} 件以下に絞ってください。`);
    batches.set(key, batch);
  }
  return [...batches.values()].map(({ target, proposalIds, operations }) => ({ target, proposalIds, operations }));
}
