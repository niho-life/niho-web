import type { DesignToken, NodeStyle, PageDocument, PageNode, TextStyle } from "./types.js";
import { parseTextStyles, parseTokens } from "./style-values.js";

/** サイト設定のスタイル部分。ページ JSON へ継承値を書き戻さない。 */
export type SiteStyles = { tokens?: Record<string, DesignToken>; textStyles?: Record<string, TextStyle>; frame?: SiteFrame };

/** 言語ごとの共通の枠。header・footer は公開時に全ページの本文の前後へ並べる。検証は parseSiteStylesWithFrame（site-frame.ts）。 */
export type SiteFrameLocale = { header: PageNode[]; footer: PageNode[]; tokens?: Record<string, DesignToken>; textStyles?: Record<string, TextStyle>; layout?: NodeStyle };
export type SiteFrame = Record<string, SiteFrameLocale>;

/** Identifies the draft snapshot consumed by the one-time normalizer; pages do not persist it. */
export type SiteStylesRevision = { readonly stage: "draft"; readonly version: string };

export type SiteStylesSnapshot = {
  readonly draft: { readonly version: string; readonly styles: SiteStyles };
  readonly published: { readonly version: string; readonly styles: SiteStyles };
};

/** サイト単体で解決できる参照だけを受け付ける。ページの値による補完は禁止。frame は扱わない（保存と編集の境界は parseSiteStylesWithFrame）。 */
export function parseSiteStyles(input: SiteStyles): SiteStyles {
  const tokens = input.tokens === undefined ? undefined : parseTokens(input.tokens, "$.site.tokens");
  const textStyles = input.textStyles === undefined ? undefined : parseTextStyles(input.textStyles, tokens ?? {}, "$.site.textStyles");
  return { ...(tokens === undefined ? {} : { tokens }), ...(textStyles === undefined ? {} : { textStyles }) };
}

/** 同名の値はページが優先。継承した文字スタイルも実効 tokens で再検証する。 */
export function mergeSiteStyles(page: SiteStyles, site: SiteStyles = {}): { tokens: Record<string, DesignToken>; textStyles?: Record<string, TextStyle> } {
  const shared = parseSiteStyles(site), tokens = parseTokens({ ...shared.tokens, ...page.tokens }, "$.tokens");
  const hasStyles = shared.textStyles !== undefined || page.textStyles !== undefined;
  const textStyles = hasStyles ? parseTextStyles({ ...shared.textStyles, ...page.textStyles }, tokens, "$.textStyles") : undefined;
  return { tokens, ...(textStyles === undefined ? {} : { textStyles }) };
}

const editorResolvedStyles = new Map<string, ReturnType<typeof mergeSiteStyles>>();
const editorResolvedStylesLimit = 32;
/** Reuse the merged style values for equivalent editor snapshots; the small LRU stays bounded. */
export function resolvePageStylesForEditor(document: PageDocument, site: SiteStyles = {}): PageDocument {
  // retainPageStyles can create equivalent token/style maps while removing inherited values.
  // Key on those small maps' contents so that equivalent editor snapshots share the same result.
  const key = JSON.stringify([document.tokens, document.textStyles, site.tokens, site.textStyles]);
  let styles = editorResolvedStyles.get(key);
  if (!styles) {
    styles = mergeSiteStyles(document, site);
    if (editorResolvedStyles.size >= editorResolvedStylesLimit) editorResolvedStyles.delete(editorResolvedStyles.keys().next().value!);
  } else editorResolvedStyles.delete(key);
  editorResolvedStyles.set(key, styles);
  return { ...document, ...styles };
}

/** 検証・描画・プレビューで共有する実効値。保存する文書には使用しない。 */
export function resolvePageStyles(document: PageDocument, site: SiteStyles = {}): PageDocument {
  return { ...document, ...mergeSiteStyles(document, site) };
}

/**
 * 部品の編集用の文書（tokens はライブラリの値）の実効値。ページでの描画と同じく、同名のサイト共通の定義をライブラリの写しより優先する。
 * ページを持たないためページの定義は重ねず、サイトにしかない定義も加えない。検証・描画・プレビュー用で、ライブラリへ書き戻す文書には使用しない。
 */
export function resolveComponentStyles(document: PageDocument, site: SiteStyles = {}): PageDocument {
  const shared = parseSiteStyles(site).tokens ?? {};
  return { ...document, tokens: Object.fromEntries(Object.entries(document.tokens).map(([name, token]) => [name, Object.hasOwn(shared, name) ? shared[name]! : token])) };
}

/** 編集用の実効値から、変更のない継承値だけを外してページの保存形式に戻す。 */
export function retainPageStyles(document: PageDocument, original: PageDocument, site: SiteStyles): PageDocument {
  let tokens = document.tokens;
  let textStyles = document.textStyles;
  for (const name of Object.keys(site.tokens ?? {})) if (!Object.hasOwn(original.tokens, name) && JSON.stringify(tokens[name]) === JSON.stringify(site.tokens![name])) {
    if (tokens === document.tokens) tokens = { ...document.tokens };
    delete tokens[name];
  }
  for (const name of Object.keys(site.textStyles ?? {})) if (textStyles && !Object.hasOwn(original.textStyles ?? {}, name) && JSON.stringify(textStyles[name]) === JSON.stringify(site.textStyles![name])) {
    if (textStyles === document.textStyles) textStyles = { ...document.textStyles };
    delete textStyles[name];
  }
  if (textStyles && !Object.keys(textStyles).length && original.textStyles === undefined) textStyles = undefined;
  if (tokens === document.tokens && textStyles === document.textStyles) return document;
  const result = { ...document, tokens, ...(textStyles === undefined ? {} : { textStyles }) };
  if (textStyles === undefined && document.textStyles !== undefined) delete result.textStyles;
  return result;
}

/** 削除候補の見た目を比較するためページ所有へ切り離す。使用中定義の実削除はhostが拒否する。 */
export function detachRemovedSiteStyles(document: PageDocument, before: SiteStyles, after: SiteStyles): PageDocument {
  const old = parseSiteStyles(before), next = parseSiteStyles(after);
  const removedSiteTokens = new Set(Object.keys(old.tokens ?? {}).filter((name) => !Object.hasOwn(next.tokens ?? {}, name)));
  const removedTokens = new Set([...removedSiteTokens].filter((name) => !Object.hasOwn(document.tokens, name)));
  const removedStyles = Object.keys(old.textStyles ?? {}).filter((name) => !Object.hasOwn(next.textStyles ?? {}, name) && !Object.hasOwn(document.textStyles ?? {}, name));
  if (!removedSiteTokens.size && !removedStyles.length) return document;
  const copy = structuredClone(document);
  const usedStyles = new Set<string>();
  const visit = (nodes: readonly PageNode[]): void => { for (const node of nodes) { if (node.type === "text") continue; if (node.style?.textStyle) usedStyles.add(node.style.textStyle); if (node.type === "element") visit(node.children); } };
  visit(document.body);
  // 削除する文字スタイルをページの override として保持することで responsive とノード指定の優先順位を保存する。
  for (const name of removedStyles) if (usedStyles.has(name)) (copy.textStyles ??= {})[name] = structuredClone(old.textStyles![name]!);
  // 残る共有文字スタイルが削除 token を使う場合も、ページの実効値を固定する。
  for (const [name, style] of Object.entries(old.textStyles ?? {})) if (usedStyles.has(name) && !Object.hasOwn(copy.textStyles ?? {}, name) && JSON.stringify(style).includes('"token"')) {
    const references = [style.base, ...(style.responsive ?? []).map((entry) => entry.declarations)].some((values) => Object.values(values).some((value) => typeof value === "object" && removedSiteTokens.has(value.token)));
    if (references) (copy.textStyles ??= {})[name] = structuredClone(style);
  }
  const replace = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(replace);
    if (!value || typeof value !== "object") return value;
    if ("token" in value && typeof value.token === "string" && removedTokens.has(value.token)) return old.tokens![value.token]!.value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replace(entry)]));
  };
  copy.body = replace(copy.body) as PageDocument["body"];
  if (copy.textStyles) copy.textStyles = replace(copy.textStyles) as NonNullable<PageDocument["textStyles"]>;
  return copy;
}
