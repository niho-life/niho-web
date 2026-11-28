import { parsePageDocument } from "./document.js";
import { managedBlockContracts } from "./managed-embed-block.js";
import { parseSiteStyles, type SiteFrame, type SiteFrameLocale, type SiteStyles } from "./site-styles.js";
import { MAX_TEXT_STYLES, parseStyle, parseTextStyles, parseTokens } from "./style-values.js";
import type { ElementNode, PageDocument, PageNode } from "./types.js";
import { fail, keys, localeCode, record } from "./validation-utils.js";

export const SITE_FRAME_LIMITS = Object.freeze({ locales: 8, nodeIdLength: 60 });

function parseFrameLocale(input: unknown, locale: string, site: SiteStyles, path: string): SiteFrameLocale {
  const entry = record(input, path);
  keys(entry, ["header", "footer", "tokens", "textStyles", "layout"], path);
  if (!Array.isArray(entry.header) || !Array.isArray(entry.footer)) fail(path, "header and footer must be arrays");
  const tokens = parseTokens(entry.tokens ?? {}, `${path}.tokens`);
  const effective = { ...site.tokens, ...tokens };
  const textStyles = entry.textStyles === undefined ? undefined : parseTextStyles(entry.textStyles, effective, `${path}.textStyles`);
  const layout = entry.layout === undefined ? undefined : parseStyle(entry.layout, effective, `${path}.layout`, { ...site.textStyles, ...textStyles }, false);
  const part = (name: "header" | "footer"): PageNode[] => {
    // ページの節点と同じ検証を通す。サイトの値は継承として解決し、枠へは書き戻さない。
    const document = parsePageDocument({ schemaVersion: 1, siteId: "frame", pageId: `frame-${name}`, locale, revision: 1, title: "Frame",
      tokens, ...(textStyles ? { textStyles } : {}), body: entry[name] }, managedBlockContracts, { siteStyles: { ...(site.tokens ? { tokens: site.tokens } : {}), ...(site.textStyles ? { textStyles: site.textStyles } : {}) } });
    const visit = (nodes: readonly PageNode[]) => nodes.forEach((node) => {
      if (node.type === "text") return;
      if (node.id.length > SITE_FRAME_LIMITS.nodeIdLength) fail(`${path}.${name}`, "frame node ID is too long");
      if (node.type !== "element") return;
      // carousel は節点 ID を参照する。公開時に枠の ID へ接頭辞を付けるため、参照が切れる。書き換えずに拒否する。
      if (node.interaction?.type === "carousel") fail(`${path}.${name}`, "carousel is not allowed in the shared frame because it references node IDs");
      visit(node.children);
    });
    visit(document.body);
    return document.body;
  };
  return { header: part("header"), footer: part("footer"), ...(Object.keys(tokens).length ? { tokens } : {}),
    ...(textStyles ? { textStyles } : {}), ...(layout ? { layout } : {}) };
}

/** 保存・編集の境界で使う。tokens・textStyles に加えて、言語ごとの共通の枠を検証して返す。 */
export function parseSiteStylesWithFrame(input: SiteStyles): SiteStyles {
  const base = parseSiteStyles(input);
  if (input.frame === undefined) return base;
  const source = record(input.frame, "$.site.frame"), locales = Object.keys(source);
  if (locales.length > SITE_FRAME_LIMITS.locales) fail("$.site.frame", "too many frame locales");
  const frame: SiteFrame = {};
  for (const locale of locales) {
    const at = `$.site.frame.${locale}`;
    localeCode(locale, at);
    frame[locale] = parseFrameLocale(source[locale], locale, base, at);
  }
  return { ...base, ...(locales.length ? { frame } : {}) };
}

/** 枠の節点に接頭辞を付ける。ページの本文と同じ HTML の id（例: footer）は枠の側から外し、ページの側を残す。 */
function withPrefix(nodes: readonly PageNode[], prefix: string, pageHtmlIds: ReadonlySet<string>): PageNode[] {
  return nodes.map((node): PageNode => {
    if (node.type === "component") return { ...node, id: prefix + node.id };
    if (node.type !== "element") return node;
    const children = withPrefix(node.children, prefix, pageHtmlIds);
    if (node.attrs?.id === undefined || !pageHtmlIds.has(String(node.attrs.id))) return { ...node, id: prefix + node.id, children };
    const { id: _htmlId, ...attrs } = node.attrs, { attrs: _attrs, ...rest } = node;
    return { ...rest, id: prefix + node.id, ...(Object.keys(attrs).length ? { attrs } : {}), children };
  });
}
function htmlIds(nodes: readonly PageNode[], result = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (node.type !== "element") continue;
    if (node.attrs?.id !== undefined) result.add(String(node.attrs.id));
    htmlIds(node.children, result);
  }
  return result;
}
function hasMain(nodes: readonly PageNode[]): boolean {
  return nodes.some((node) => node.type === "element" && (node.tag === "main" || hasMain(node.children)));
}
function ids(nodes: readonly PageNode[], result: string[] = []): string[] {
  for (const node of nodes) { if (node.type === "text") continue; result.push(node.id); if (node.type === "element") ids(node.children, result); }
  return result;
}

/**
 * 公開時に本文（CMS の結び付けを解決した後）を共通の枠で包む。その言語の枠が無ければ文書をそのまま返す。
 * 枠の節点の ID には接頭辞を付け、本文と重ならないようにする。tokens・textStyles は同名ならページを優先する。
 */
export function composeSiteFrame(document: PageDocument, frame: SiteFrame | undefined): PageDocument {
  const entry = frame?.[document.locale];
  if (!entry) return document;
  const used = ids(document.body), pageIds = htmlIds(document.body);
  let base = "nwframe", attempt = 0;
  while (used.some((id) => id.startsWith(base))) base = `nwframe${++attempt}x`;
  // 本文に main が既にあれば、包みは div にして main を二重にしない。
  const main: ElementNode = { type: "element", id: `${base}-main`, tag: hasMain(document.body) ? "div" : "main", children: document.body };
  const root: ElementNode = { type: "element", id: `${base}-root`, tag: "div", ...(entry.layout ? { style: entry.layout } : {}),
    children: [...withPrefix(entry.header, `${base}-h-`, pageIds), main, ...withPrefix(entry.footer, `${base}-f-`, pageIds)] };
  const tokens = { ...entry.tokens, ...document.tokens }, merged = { ...entry.textStyles, ...document.textStyles };
  // 枠とページを足すと上限を超えることがある（取り込んだ鎌倉のトップ）。そのときは、どの節点も使っていないものを外す。
  const textStyles = Object.keys(merged).length > MAX_TEXT_STYLES ? usedTextStyles(merged, [root]) : merged;
  return { ...document, tokens, ...(Object.keys(textStyles).length ? { textStyles } : {}), body: [root] };
}
function usedTextStyles<T>(textStyles: Readonly<Record<string, T>>, nodes: readonly PageNode[]): Record<string, T> {
  const used = new Set<string>();
  const visit = (items: readonly PageNode[]) => { for (const node of items) {
    if (node.type === "text") continue;
    if (node.style?.textStyle) used.add(node.style.textStyle);
    if (node.type === "element") visit(node.children);
  } };
  visit(nodes);
  return Object.fromEntries(Object.entries(textStyles).filter(([name]) => used.has(name)));
}
