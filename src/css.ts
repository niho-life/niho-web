import { resolvePageStyles, type SiteStyles } from "./site-styles.js";
import type { AppearEffect, BlockContracts, DesignToken, NodeStyle, PageDocument, PageNode, StateName, StateProperty, StyleDeclarations, StyleProperty } from "./types.js";
import { parsePageDocument } from "./document.js";
import { declarationCss, fontFamilyCss, motionProperties, tokenCssValue } from "./style-values.js";
import { parseResolvedAssets, resolvedAsset, type ResolvedAssetMap } from "./assets.js";
import { identifier, localeCode } from "./validation-utils.js";

/** 長さを付けて区切るため、異なる ID の組み合わせが同じ scope にならない。 */
export function pageScope(document: Pick<PageDocument, "siteId" | "pageId" | "locale" | "revision">): string {
  return "nw-" + [document.siteId, document.pageId, document.locale, String(document.revision)]
    .map((value) => `${value.length}-${value}`).join("-");
}
export type PageScopeIdentity = Pick<PageDocument, "siteId" | "pageId" | "locale" | "revision">;
/** 公開DOMの data-nw-scope から、元の文書識別子とrevisionを安全に復元する。 */
export function parsePageScope(value: unknown): PageScopeIdentity | undefined {
  if (typeof value !== "string" || value.length > 500 || !value.startsWith("nw-")) return undefined;
  const parts: string[] = [];
  let offset = 3;
  for (let index = 0; index < 4; index++) {
    const delimiter = value.indexOf("-", offset);
    if (delimiter < 0) return undefined;
    const lengthText = value.slice(offset, delimiter);
    if (!/^(?:0|[1-9][0-9]*)$/u.test(lengthText)) return undefined;
    const length = Number(lengthText), start = delimiter + 1, end = start + length;
    if (!Number.isSafeInteger(length) || end > value.length) return undefined;
    if (index < 3 ? value[end] !== "-" : end !== value.length) return undefined;
    parts.push(value.slice(start, end));
    offset = end + 1;
  }
  try {
    if (!/^[1-9][0-9]*$/u.test(parts[3]!)) return undefined;
    const revision = Number(parts[3]);
    if (!Number.isSafeInteger(revision)) return undefined;
    const identity = {
      siteId: identifier(parts[0], "$scope.siteId"),
      pageId: identifier(parts[1], "$scope.pageId"),
      locale: localeCode(parts[2], "$scope.locale"),
      revision
    };
    return pageScope(identity) === value ? identity : undefined;
  } catch {
    return undefined;
  }
}
// 遷移は状態スタイルを持つノードの動きの規則だけに出す。
const motion = new Set<string>(motionProperties);
const sideBorderProperties = new Set<string>([
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
  "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor"
]);
const isolatedBackgroundProperties = new Set<string>(["backgroundImage", "backgroundSize", "backgroundPosition", "backgroundRepeat", "backgroundFilter"]);
const canvasMotionProperties = new Set<string>(motionProperties);
type CanvasValueTier = "base" | `responsive-${number}` | `state-${StateName}` | `text-base` | `text-responsive-${number}` | `slot-${string}-base` | `slot-${string}-responsive-${number}`;
// Document token names start with a lowercase letter; the uppercase namespace cannot collide with them.
const canvasValueName = (nodeId: string, tier: CanvasValueTier, property: string) => `--nw-Node-${nodeId}-${tier}-${property}`;
function canvasCssValue(property: string, value: StyleDeclarations[keyof StyleDeclarations], assets: ResolvedAssetMap): string | undefined {
  if (property === "backgroundImage") {
    if (value === "none") return "none";
    if (!value || typeof value !== "object" || !("asset" in value)) return undefined;
    const resolved = resolvedAsset(assets, value.asset);
    return resolved ? `url("${resolved.src}")` : undefined;
  }
  if (value === undefined || typeof value === "object" && !("token" in value)) return undefined;
  const declaration = declarationCss(property as StyleProperty, value);
  return declaration.slice(declaration.indexOf(":") + 1, -1);
}
function canvasVariableDeclarations(values: StyleDeclarations, assets: ResolvedAssetMap, nodeId: string, tier: CanvasValueTier, mode: "all" | "withoutIsolatedBackground" | "isolatedBackground" = "all"): string {
  return styleDeclarationOrder(values).filter((property) => !canvasMotionProperties.has(property)
    && (mode === "all" || (mode === "isolatedBackground" ? isolatedBackgroundProperties.has(property) : !isolatedBackgroundProperties.has(property))))
    .map((property) => {
      const value = canvasCssValue(property, values[property], assets);
      if (value === undefined) return "";
      const cssName = property === "backgroundFilter" ? "filter" : property === "skew" ? "transform" : property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      return `${cssName}:var(${canvasValueName(nodeId, tier, property)});`;
    }).join("");
}
function putCanvasValues(target: Record<string, string>, values: StyleDeclarations | undefined, assets: ResolvedAssetMap, nodeId: string, tier: CanvasValueTier): void {
  if (!values) return;
  for (const property of Object.keys(values) as (keyof StyleDeclarations)[]) {
    const value = canvasCssValue(property, values[property], assets);
    if (value !== undefined) target[canvasValueName(nodeId, tier, property)] = value;
  }
}
/** 編集キャンバスのノードへ設定する値だけの CSS 変数。公開描画には使わない。 */
export function canvasNodeStyleValues(node: Exclude<PageNode, { type: "text" | "instance" }>, textStyles: PageDocument["textStyles"], assets: ResolvedAssetMap = {}, viewportHeight?: number): Record<string, string> {
  const result: Record<string, string> = {};
  if (node.style?.textStyle) {
    const style = textStyles?.[node.style.textStyle];
    if (style) {
      putCanvasValues(result, style.base, assets, node.id, "text-base");
      for (const responsive of style.responsive ?? []) putCanvasValues(result, responsive.declarations, assets, node.id, `text-responsive-${responsive.minWidth}`);
    }
  }
  if (node.style) {
    const isolatedBackground = [node.style.base, ...(node.style.responsive ?? []).map((entry) => entry.declarations)].some((values) => values?.backgroundFilter !== undefined);
    const base = isolatedBackground && node.style.base?.position === "static" ? { ...node.style.base, position: "relative" } : node.style.base;
    putCanvasValues(result, base, assets, node.id, "base");
    for (const responsive of node.style.responsive ?? []) {
      const declarations = isolatedBackground && responsive.declarations.position === "static" ? { ...responsive.declarations, position: "relative" } : responsive.declarations;
      putCanvasValues(result, declarations, assets, node.id, `responsive-${responsive.minWidth}`);
    }
    for (const state of ["hover", "focus", "active"] as const) putCanvasValues(result, node.style.states?.[state], assets, node.id, `state-${state}`);
    if (node.style.appear) {
      result[canvasValueName(node.id, "base", "appearDuration")] = `${node.style.appear.duration}ms`;
      result[canvasValueName(node.id, "base", "appearDelay")] = `${node.style.appear.delay}ms`;
      result[canvasValueName(node.id, "base", "appearEasing")] = node.style.appear.easing ?? "ease";
    }
  }
  if (node.type === "component") for (const [slot, style] of Object.entries(node.slots ?? {})) {
    putCanvasValues(result, style.base, assets, node.id, `slot-${slot}-base`);
    for (const responsive of style.responsive ?? []) putCanvasValues(result, responsive.declarations, assets, node.id, `slot-${slot}-responsive-${responsive.minWidth}`);
  }
  if (viewportHeight) for (const [name, value] of Object.entries(result)) result[name] = resolveViewportHeightUnits(value, viewportHeight);
  return result;
}
/** 編集キャンバスの scope に設定する文書 token の CSS 変数。 */
export function canvasTokenStyleValues(tokens: Record<string, DesignToken>, viewportHeight?: number): Record<string, string> {
  const result = Object.fromEntries(Object.entries(tokens).map(([name, token]) => [
    `--nw-${name}`, token.type === "fontFamily" ? fontFamilyCss(tokenCssValue(token)) : tokenCssValue(token)
  ]));
  if (viewportHeight) for (const [name, value] of Object.entries(result)) result[name] = resolveViewportHeightUnits(value, viewportHeight);
  return result;
}
/** @internal Keep normalization verification in the same shorthand order as the renderer. */
export function styleDeclarationOrder(values: StyleDeclarations): (StyleProperty | "backgroundImage")[] {
  const properties = (Object.keys(values) as (StyleProperty | "backgroundImage")[]).sort();
  // CSS shorthand は後にあると side-specific longhand を上書きするため、同じ rule 内で先に出す。
  for (const common of ["borderWidth", "borderStyle", "borderColor"] as const) {
    const index = properties.indexOf(common), firstSide = properties.findIndex((property) => sideBorderProperties.has(property));
    if (index > firstSide && firstSide >= 0) properties.splice(firstSide, 0, properties.splice(index, 1)[0]!);
  }
  // gap shorthand は後にあると、同じ rule の columnGap / rowGap を上書きする。
  const gapIndex = properties.indexOf("gap"), firstAxisGap = properties.findIndex((property) => property === "columnGap" || property === "rowGap");
  if (gapIndex > firstAxisGap && firstAxisGap >= 0) properties.splice(firstAxisGap, 0, properties.splice(gapIndex, 1)[0]!);
  return properties;
}
function declarations(values: StyleDeclarations, assets: ResolvedAssetMap, mode: "all" | "withoutIsolatedBackground" | "isolatedBackground" = "all"): string {
  return styleDeclarationOrder(values).filter((property) => !motion.has(property)
    && (mode === "all" || (mode === "isolatedBackground" ? isolatedBackgroundProperties.has(property) : !isolatedBackgroundProperties.has(property))))
    .map((property) => {
      if (property === "backgroundFilter") return `filter:${declarationCss(property, values[property]!).slice("background-filter:".length)}`;
      if (property !== "backgroundImage") return declarationCss(property, values[property]!);
      // src は parseResolvedAssets で引用符・空白・<> を拒否済み。解決できない宣言だけ省く。
      if (values.backgroundImage === "none") return "background-image:none;";
      const resolved = resolvedAsset(assets, values.backgroundImage!.asset);
      return resolved ? `background-image:url("${resolved.src}");` : "";
    }).join("");
}
const reduced = "@media (prefers-reduced-motion:no-preference)";
const transitionNames: readonly [StateProperty, string][] = [["color", "color"], ["backgroundColor", "background-color"], ["borderColor", "border-color"], ["opacity", "opacity"],
  ["translate", "translate"], ["rotate", "rotate"], ["scale", "scale"], ["skew", "transform"], ["textDecorationLine", "text-decoration-color"]];
/** @internal The emitted transition-property list is derived from properties used by state rules. */
export function stateTransitionProperties(style: NodeStyle | undefined): string[] {
  const used = new Set(Object.values(style?.states ?? {}).flatMap((values) => Object.keys(values)));
  return transitionNames.filter(([property]) => used.has(property)).map(([, css]) => css);
}
// 動き始めの姿だけを持つ。終わりは要素の通常の見た目なので、動かない環境では内容がそのまま見える。
const keyframes: Record<AppearEffect, string> = { fade: "opacity:0", "fade-up": "opacity:0;translate:0 24px", "fade-down": "opacity:0;translate:0 -24px",
  "fade-left": "opacity:0;translate:24px 0", "fade-right": "opacity:0;translate:-24px 0", zoom: "opacity:0;scale:.92" };
const stateRule = (selector: string, state: StateName, body: string) => state === "hover" ? `@media (hover:hover){${selector}:hover{${body}}}` : `${selector}:${state === "focus" ? "focus-visible" : "active"}{${body}}`;
/** @internal エディターのキャンバス用。forceState は選択中の要素へ状態の見た目を擬似クラスなしで重ね、paused は動きを止める。 */
export type CanvasCssOptions = { forceState?: { nodeId: string; state: StateName } | undefined; motion?: "paused" | "play" | undefined; /** @internal Keep dynamic declarations out of the editor's style sheet. */ inlineStyleValues?: boolean | undefined };
/** @internal True when an immutable value-only edit leaves the editor stylesheet structure unchanged. */
export function sameCanvasCssShape(previous: PageDocument, next: PageDocument): boolean {
  if (previous === next) return true;
  if (pageScope(previous) !== pageScope(next)) return false;
  const sameKeys = (left: object | undefined, right: object | undefined): boolean => {
    if (left === right) return true;
    if (!left || !right) return false;
    const leftKeys = Object.keys(left).sort(), rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]);
  };
  const sameDeclarations = (left: StyleDeclarations | undefined, right: StyleDeclarations | undefined): boolean =>
    sameKeys(left, right) && left?.backgroundImage === right?.backgroundImage;
  const sameStyle = (left: NodeStyle | undefined, right: NodeStyle | undefined): boolean => {
    if (left === right) return true;
    if (!left || !right || left.textStyle !== right.textStyle || left.appear !== right.appear || left.hidden !== right.hidden ||
      !sameDeclarations(left.base, right.base)) return false;
    const leftResponsive = left.responsive ?? [], rightResponsive = right.responsive ?? [];
    if (leftResponsive.length !== rightResponsive.length || leftResponsive.some((entry, index) => {
      const candidate = rightResponsive[index];
      return !candidate || entry.minWidth !== candidate.minWidth || !sameDeclarations(entry.declarations, candidate.declarations);
    })) return false;
    for (const state of ["hover", "focus", "active"] as const) {
      if (!sameDeclarations(left.states?.[state], right.states?.[state])) return false;
    }
    return true;
  };
  const sameNodes = (left: readonly PageNode[], right: readonly PageNode[]): boolean => {
    if (left === right) return true;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      const previousNode = left[index]!, nextNode = right[index]!;
      if (previousNode === nextNode) continue;
      if (previousNode.type === "text") {
        if (nextNode.type !== "text") return false;
        continue;
      }
      if (nextNode.type === "text" || previousNode.type !== nextNode.type || previousNode.id !== nextNode.id || !sameStyle(previousNode.style, nextNode.style)) return false;
      if (previousNode.type === "element" && nextNode.type === "element") {
        if (previousNode.tag !== nextNode.tag || !sameNodes(previousNode.children, nextNode.children)) return false;
      } else if (previousNode.type === "component" && nextNode.type === "component") {
        const leftSlots = previousNode.slots ?? {}, rightSlots = nextNode.slots ?? {};
        if (!sameKeys(leftSlots, rightSlots) || Object.keys(leftSlots).some((slot) => !sameStyle(leftSlots[slot], rightSlots[slot]))) return false;
      }
    }
    return true;
  };
  const leftTextStyles = previous.textStyles ?? {}, rightTextStyles = next.textStyles ?? {};
  return sameNodes(previous.body, next.body) && sameKeys(leftTextStyles, rightTextStyles) &&
    Object.keys(leftTextStyles).every((name) => sameStyle(leftTextStyles[name], rightTextStyles[name]));
}
/** @internal 文書の CSS の後に置く、キャンバスだけの規則。 */
export function canvasCss(document: PageDocument, options: CanvasCssOptions, assets: ResolvedAssetMap = {}): string {
  const rules: string[] = [], scope = pageScope(document), forced = options.forceState;
  if (forced) {
    const visit = (nodes: PageNode[]): NodeStyle | undefined => { for (const node of nodes) { if (node.type === "text") continue; if (node.id === forced.nodeId) return node.style; if (node.type === "element") { const found = visit(node.children); if (found) return found; } } return undefined; };
    const values = visit(document.body)?.states?.[forced.state];
    if (values && Object.keys(values).length) rules.push(`[data-nw-scope="${scope}"] [data-nw-owner="${scope}"][data-nw-node="${forced.nodeId}"][data-nw-node="${forced.nodeId}"]{${options.inlineStyleValues ? canvasVariableDeclarations(values, assets, forced.nodeId, `state-${forced.state}`) : declarations(values, assets)}}`);
  }
  if (options.motion === "paused") rules.push(`[data-nw-scope="${scope}"],[data-nw-scope="${scope}"] *{animation:none!important;transition:none!important}`);
  return rules.join("\n");
}
/**
 * @internal エディターのキャンバス用。キャンバスの iframe の高さは表示倍率で変わる（作業領域÷倍率）ため、
 * `vh`／`dvh`／`svh`／`lvh` を基準の viewport 高さ（倍率 100% のときの高さ）の px に置き換え、倍率でレイアウトが変わらないようにする。
 * 公開の描画には使わない。数の直前が識別子の文字のときは置き換えない（scope 名などを壊さない）。
 */
export function resolveViewportHeightUnits(css: string, viewportHeight: number): string {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return css;
  return css.replace(/(?<![\w.-])(-?(?:\d+(?:\.\d+)?|\.\d+))(?:dvh|svh|lvh|vh)\b/g, (_match, value: string) => `${Number((Number(value) * viewportHeight / 100).toFixed(3))}px`);
}
/** @internal 検証済み文書と素材マップだけで利用。公開 API は必ず再検証する。 */
export function cssForDocument(document: PageDocument, assets: ResolvedAssetMap = {}, options: CanvasCssOptions = {}): string {
  const scope = `[data-nw-scope="${pageScope(document)}"]`;
  const rules: string[] = [];
  const tokens = options.inlineStyleValues ? "" : Object.entries(document.tokens).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, token]) => `--nw-${name}:${token.type === "fontFamily" ? fontFamilyCss(tokenCssValue(token)) : tokenCssValue(token)};`).join("");
  // box sizing の規則も文書の外には出さない。
  const owner = `[data-nw-owner="${pageScope(document)}"]`;
  rules.push(`${scope}{box-sizing:border-box;${tokens}}`, `${scope} ${owner}[data-nw-node]{box-sizing:border-box;}`);
  // 文字スタイルはノード規則より前に出す。selector の詳細度が同じなので、後に出るノード個別の指定が全幅で勝つ。
  const users = new Map<string, { selector: string; nodeId: string }[]>();
  (function collect(nodes: PageNode[]): void {
    for (const node of nodes) {
      if (node.type === "text") continue;
      if (node.style?.textStyle) {
        let selectors = users.get(node.style.textStyle);
        if (!selectors) { selectors = []; users.set(node.style.textStyle, selectors); }
        selectors.push({ selector: `${scope} ${owner}[data-nw-node="${node.id}"]`, nodeId: node.id });
      }
      if (node.type === "element") collect(node.children);
    }
  })(document.body);
  for (const [name, style] of Object.entries(document.textStyles ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const styleUsers = users.get(name);
    if (!styleUsers?.length) continue;
    if (options.inlineStyleValues) {
      for (const { selector, nodeId } of styleUsers) {
        const base = canvasVariableDeclarations(style.base, assets, nodeId, "text-base");
        if (base) rules.push(`${selector}{${base}}`);
        for (const responsive of style.responsive ?? []) {
          const body = canvasVariableDeclarations(responsive.declarations, assets, nodeId, `text-responsive-${responsive.minWidth}`);
          if (body) rules.push(`@media (min-width:${responsive.minWidth}px){${selector}{${body}}}`);
        }
      }
    } else {
      const selector = styleUsers.map(({ selector }) => selector).join(",");
      if (Object.keys(style.base).length) rules.push(`${selector}{${declarations(style.base, assets)}}`);
      for (const responsive of style.responsive ?? []) {
        if (Object.keys(responsive.declarations).length) rules.push(`@media (min-width:${responsive.minWidth}px){${selector}{${declarations(responsive.declarations, assets)}}}`);
      }
    }
  }
  function visit(nodes: PageNode[]): void {
    for (const node of nodes) {
      if (node.type === "text") continue;
      const selector = `${scope} ${owner}[data-nw-node="${node.id}"]`;
      // The UA content wrapper is a flex item in modern details; fill the authored box.
      if (node.type === "element" && node.tag === "details") rules.push(`${selector}::details-content{width:100%;min-width:0;}`);
      const isolatedBackground = [node.style?.base, ...(node.style?.responsive ?? []).map((entry) => entry.declarations)]
        .some((values) => values?.backgroundFilter !== undefined);
      const boxDeclarations = (values: StyleDeclarations, tier: CanvasValueTier) => {
        const adjusted = isolatedBackground && values.position === "static" ? { ...values, position: "relative" } : values;
        return options.inlineStyleValues ? canvasVariableDeclarations(adjusted, assets, node.id, tier, isolatedBackground ? "withoutIsolatedBackground" : "all") : declarations(adjusted, assets, isolatedBackground ? "withoutIsolatedBackground" : "all");
      };
      // 遷移だけの指定は動きの規則に出すので、空の規則を残さない（旧文書の空の規則はそのまま）。
      const motionOnly = (values: StyleDeclarations) => Object.keys(values).some((property) => motion.has(property)) && !declarations(values, assets);
      if (node.style?.base && !motionOnly(node.style.base)) rules.push(`${selector}{${isolatedBackground ? `isolation:isolate;${node.style?.base?.position ? "" : "position:relative;"}` : ""}${boxDeclarations(node.style.base, "base")}}`);
      else if (isolatedBackground) rules.push(`${selector}{isolation:isolate;position:relative;}`);
      for (const responsive of node.style?.responsive ?? []) {
        if (!motionOnly(responsive.declarations)) rules.push(`@media (min-width:${responsive.minWidth}px){${selector}{${boxDeclarations(responsive.declarations, `responsive-${responsive.minWidth}`)}}}`);
      }
      if (isolatedBackground) {
        const base = options.inlineStyleValues ? canvasVariableDeclarations(node.style?.base ?? {}, assets, node.id, "base", "isolatedBackground") : declarations(node.style?.base ?? {}, assets, "isolatedBackground");
        rules.push(`${selector}::before{content:"";position:absolute;inset:0;width:100%;height:100%;border-radius:inherit;pointer-events:none;z-index:-1;${base}}`);
        for (const responsive of node.style?.responsive ?? []) {
          const body = options.inlineStyleValues ? canvasVariableDeclarations(responsive.declarations, assets, node.id, `responsive-${responsive.minWidth}`, "isolatedBackground") : declarations(responsive.declarations, assets, "isolatedBackground");
          if (body) rules.push(`@media (min-width:${responsive.minWidth}px){${selector}::before{${body}}}`);
        }
      }
      if (node.type === "component") for (const [slot, style] of Object.entries(node.slots ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        // ブロックが data-nw-slot を付けた内側の要素。繰り返すカード等、同じ領域のすべてに適用する。
        const inner = `${selector} [data-nw-slot="${slot}"]`;
        if (style.base) rules.push(`${inner}{${options.inlineStyleValues ? canvasVariableDeclarations(style.base, assets, node.id, `slot-${slot}-base`) : declarations(style.base, assets)}}`);
        for (const responsive of style.responsive ?? []) rules.push(`@media (min-width:${responsive.minWidth}px){${inner}{${options.inlineStyleValues ? canvasVariableDeclarations(responsive.declarations, assets, node.id, `slot-${slot}-responsive-${responsive.minWidth}`) : declarations(responsive.declarations, assets)}}}`);
      }
      if (node.type === "element") visit(node.children);
    }
  }
  visit(document.body);
  // 状態 → 動き（遷移・登場）→ 幅別の非表示の順。非表示は最後なので、どの段の display より優先する。
  const styled: { selector: string; nodeId: string; style: NodeStyle }[] = [];
  (function each(nodes: PageNode[]): void {
    for (const node of nodes) {
      if (node.type === "text") continue;
      if (node.style) styled.push({ selector: `${scope} ${owner}[data-nw-node="${node.id}"]`, nodeId: node.id, style: node.style });
      if (node.type === "element") each(node.children);
    }
  })(document.body);
  for (const { selector, nodeId, style } of styled) for (const state of ["hover", "focus", "active"] as const) {
    const values = style.states?.[state];
    if (values && Object.keys(values).length) rules.push(stateRule(selector, state, options.inlineStyleValues ? canvasVariableDeclarations(values, assets, nodeId, `state-${state}`) : declarations(values, assets)));
  }
  const paused = options.motion === "paused", effects = new Set<AppearEffect>(), name = (effect: AppearEffect) => `${pageScope(document)}-${effect}`;
  for (const { selector, nodeId, style } of paused ? [] : styled) {
    const properties = stateTransitionProperties(style).join(",");
    const timing = (values: StyleDeclarations | undefined, nodeId: string, tier: CanvasValueTier) => motionProperties.filter((property) => values?.[property] !== undefined).map((property) => options.inlineStyleValues
      ? `${property === "skew" ? "transform" : property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:var(${canvasValueName(nodeId, tier, property)});`
      : declarationCss(property, values![property]!)).join("");
    const base = timing(style.base, nodeId, "base"), widths = (style.responsive ?? []).map((entry) => [entry.minWidth, timing(entry.declarations, nodeId, `responsive-${entry.minWidth}`)] as const).filter(([, body]) => body);
    if (properties && (base || widths.length)) {
      rules.push(`${reduced}{${selector}{transition-property:${properties};${base}}}`);
      for (const [minWidth, body] of widths) rules.push(`${reduced} and (min-width:${minWidth}px){${selector}{${body}}}`);
    }
    const appear = style.appear;
    if (!appear) continue;
    effects.add(appear.effect);
    const easing = appear.easing ?? "ease";
    const duration = options.inlineStyleValues ? `var(${canvasValueName(nodeId, "base", "appearDuration")})` : `${appear.duration}ms`;
    const delay = options.inlineStyleValues ? `var(${canvasValueName(nodeId, "base", "appearDelay")})` : `${appear.delay}ms`;
    const easingValue = options.inlineStyleValues ? `var(${canvasValueName(nodeId, "base", "appearEasing")})` : easing;
    rules.push(appear.trigger === "load" ? `${reduced}{${selector}{animation:${name(appear.effect)} ${duration} ${easingValue} ${delay} both}}`
      : `${reduced}{@supports (animation-timeline: view()){${selector}{animation:${name(appear.effect)} auto ${easingValue} both;animation-timeline:view();animation-range:entry 0% entry 60%}}}`);
  }
  // keyframes は文書 scope 付きの名前で、使われた効果だけ。
  for (const effect of [...effects].sort()) rules.push(`@keyframes ${name(effect)}{from{${keyframes[effect]}}}`);
  for (const { selector, style } of styled) for (const range of style.hidden ?? []) {
    const media = [range.minWidth ? `(min-width:${range.minWidth}px)` : "", range.maxWidth === undefined ? "" : `(max-width:${range.maxWidth}.98px)`].filter(Boolean).join(" and ");
    rules.push(media ? `@media ${media}{${selector}{display:none}}` : `${selector}{display:none}`);
  }
  const extra = canvasCss(document, options, assets);
  if (extra) rules.push(extra);
  return rules.join("\n");
}
export function generatePageCss(input: unknown, blocks: BlockContracts = {}, assets?: unknown, siteStyles?: SiteStyles): string {
  return cssForDocument(resolvePageStyles(parsePageDocument(input, blocks, siteStyles ? { siteStyles } : {}), siteStyles), assets === undefined ? {} : parseResolvedAssets(assets));
}
