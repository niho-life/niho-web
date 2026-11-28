import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import type { ElementAttributes, ElementNode, ElementTag, PageNode } from "../src/types.js";
import { isSafePublicLink, isSafePublicUrl } from "../src/validation-utils.js";
import { escapeHtml } from "./managed-cms-model.js";

/**
 * CMS の本文（richText の HTML）を公開ページの要素へ変換します。許可した要素と属性だけを組み立てます。
 * `script`・`style`・`iframe`・フォームなどは中身ごと落とし、知らない要素は外して中身を残します。表は行ごとの段落にします。
 * 画像の origin と CSP は、固定ページと同じ公開の制限が後で確かめます。
 */

type SourceNode = DefaultTreeAdapterTypes.ChildNode;
type SourceElement = DefaultTreeAdapterTypes.Element;
/** depth は作る要素の深さ、level は元の HTML をたどる深さです。 */
type Context = { readonly phrasing: boolean; readonly link: boolean; readonly depth: number; readonly level: number };

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const MAX_DEPTH = 24;
const MAX_SOURCE_LEVEL = 128;
const DROPPED = new Set(("script style template iframe frame frameset object embed applet noscript noembed noframes svg math link meta base title head "
  + "form input button select option optgroup textarea canvas audio video source track param picture map area dialog portal slot datalist output").split(" "));
const BLOCKS: ReadonlyMap<string, ElementTag> = new Map<string, ElementTag>([["p", "p"], ["pre", "p"], ["tr", "p"], ["h1", "h2"], ["h2", "h2"],
  ["h3", "h3"], ["h4", "h4"], ["h5", "h4"], ["h6", "h4"], ["ul", "ul"], ["ol", "ol"], ["blockquote", "blockquote"], ["figure", "figure"],
  ["figcaption", "figcaption"], ["div", "div"]]);
const INLINE: ReadonlyMap<string, ElementTag> = new Map<string, ElementTag>([["strong", "strong"], ["b", "strong"], ["em", "em"], ["i", "em"], ["small", "small"]]);
/** 段落と見出しの中身は、公開ページでも文の要素だけです。 */
const TEXT_ONLY = new Set<ElementTag>(["p", "h2", "h3", "h4"]);
/** 目次の飛び先（STUDIO の見出し ID）。ページの他の要素と重ならない形だけを残します。 */
const HEADING_ID = /^index_[A-Za-z0-9_-]{1,64}$/u;
const REL = /^(?:noopener|noreferrer|nofollow|sponsored|ugc)$/u;
const SIZE = /^[1-9]\d{0,4}$/u;

/** 公開 release の本文はエスケープした文字列です。`escapeHtml` の逆変換で元の HTML に戻します。 */
export function decodeCmsReleaseRichText(value: string): string {
  const entities: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
  return value.replace(/&(amp|lt|gt|quot|#39);/gu, (_match, name: string) => entities[name]!);
}

/** 深すぎる入れ子は、再帰せずに文字だけを順に取り出します。 */
function sourceText(nodes: readonly SourceNode[]): PageNode[] {
  const pending = [...nodes].reverse();
  let text = "";
  while (pending.length) {
    const node = pending.pop()!;
    if (node.nodeName === "#text") text += (node as DefaultTreeAdapterTypes.TextNode).value;
    else if ("tagName" in node && node.namespaceURI === HTML_NAMESPACE && !DROPPED.has(node.tagName)) {
      for (let index = node.childNodes.length - 1; index >= 0; index--) pending.push(node.childNodes[index]!);
    }
  }
  return text ? [{ type: "text", text }] : [];
}

/** `headingIds` を共有すると、1ページに本文が複数回出ても見出し ID は重複しません。 */
export function cmsRichTextNodes(html: string, newId: () => string, headingIds = new Set<string>()): PageNode[] {
  const attribute = (element: SourceElement, name: string) => element.attrs.find((entry) => entry.name === name && !entry.namespace)?.value;
  const element = (tag: ElementTag, children: PageNode[], attrs?: ElementAttributes): ElementNode =>
    ({ type: "element", id: newId(), tag, ...(attrs && Object.keys(attrs).length ? { attrs } : {}), children });

  function image(source: SourceElement): PageNode[] {
    const src = attribute(source, "src")?.trim();
    if (!src || src.startsWith("#") || !isSafePublicUrl(src)) return [];
    const attrs: ElementAttributes = { src, alt: (attribute(source, "alt") ?? "").slice(0, 500) };
    for (const name of ["width", "height"] as const) {
      const size = attribute(source, name)?.trim();
      if (size && SIZE.test(size)) attrs[name] = Number(size);
    }
    return [element("img", [], attrs)];
  }

  const inside = (context: Context): Context => ({ ...context, depth: context.depth + 1, level: context.level + 1 });

  function link(source: SourceElement, context: Context): PageNode[] {
    const href = attribute(source, "href")?.trim();
    if (context.link || !href || !isSafePublicLink(href)) return convert(source.childNodes, { ...context, level: context.level + 1 });
    const attrs: ElementAttributes = { href };
    const rel = (attribute(source, "rel") ?? "").split(/\s+/u).filter((token) => REL.test(token));
    if (attribute(source, "target") === "_blank") {
      attrs.target = "_blank";
      if (!rel.includes("noopener")) rel.push("noopener");
    }
    if (rel.length) attrs.rel = [...new Set(rel)].join(" ");
    return [element("a", convert(source.childNodes, { ...inside(context), phrasing: true, link: true }), attrs)];
  }

  /** ul / ol の直下は li だけです。ほかの内容は項目にまとめます。 */
  function listItems(nodes: readonly SourceNode[], context: Context): PageNode[] {
    const items: PageNode[] = [];
    let loose: PageNode[] = [];
    const flush = () => {
      if (loose.some((node) => node.type !== "text" || node.text.trim())) items.push(element("li", loose));
      loose = [];
    };
    for (const node of nodes) {
      if ("tagName" in node && node.tagName === "li" && node.namespaceURI === HTML_NAMESPACE) {
        flush();
        items.push(element("li", convert(node.childNodes, inside(context))));
      } else loose.push(...convert([node], inside(context)));
    }
    flush();
    return items;
  }

  function convert(nodes: readonly SourceNode[], context: Context): PageNode[] {
    return nodes.flatMap((node): PageNode[] => {
      if (node.nodeName === "#text") {
        const text = (node as DefaultTreeAdapterTypes.TextNode).value;
        return text ? [{ type: "text", text }] : [];
      }
      if (!("tagName" in node) || node.namespaceURI !== HTML_NAMESPACE || DROPPED.has(node.tagName)) return [];
      const name = node.tagName;
      if (context.depth >= MAX_DEPTH || context.level >= MAX_SOURCE_LEVEL) return sourceText([node]);
      const unwrapped = () => convert(node.childNodes, { ...context, level: context.level + 1 });
      if (name === "br") return [element("br", [])];
      if (name === "hr") return context.phrasing ? [] : [element("hr", [])];
      if (name === "img") return image(node);
      if (name === "a") return link(node, context);
      if (name === "td" || name === "th") return [...unwrapped(), { type: "text", text: " " }];
      const inline = INLINE.get(name);
      if (inline) return [element(inline, convert(node.childNodes, { ...inside(context), phrasing: true }))];
      // li は一覧の中でだけ使えます。一覧の外に置かれた li は区切りの要素にします。
      const block = name === "li" ? "div" : BLOCKS.get(name);
      if (!block || context.phrasing) return unwrapped();
      if (block === "ul" || block === "ol") {
        const items = listItems(node.childNodes, inside(context));
        return items.length ? [element(block, items)] : [];
      }
      const attrs: ElementAttributes = {};
      const id = attribute(node, "id");
      if (/^h[2-4]$/u.test(block) && id && HEADING_ID.test(id) && !headingIds.has(id)) {
        headingIds.add(id);
        attrs.id = id;
      }
      return [element(block, convert(node.childNodes, { ...inside(context), phrasing: TEXT_ONLY.has(block) }), attrs)];
    });
  }

  return convert(parseFragment(html).childNodes, { phrasing: false, link: false, depth: 0, level: 0 });
}

/** 1ページ分の本文の変換。公開 release の値は `released` を指定してエスケープを戻します。 */
export function cmsRichTextProjection({ released }: { readonly released: boolean }) {
  const headingIds = new Set<string>();
  return (value: string, newId: () => string): PageNode[] => cmsRichTextNodes(released ? decodeCmsReleaseRichText(value) : value, newId, headingIds);
}

/** 画面や説明文に使う、本文の文字だけを取り出します。 */
export function cmsRichTextPlainText(nodes: readonly PageNode[]): string {
  return nodes.map((node) => node.type === "text" ? node.text : node.type !== "element" ? ""
    : node.tag === "br" ? " " : `${cmsRichTextPlainText(node.children)}${TEXT_ONLY.has(node.tag) || node.tag === "li" ? " " : ""}`).join("")
    .replace(/\s+/gu, " ").trim();
}

/** ページの要素を使わない CMS の標準ページ向けに、変換した本文を HTML にします。 */
export function renderCmsRichTextHtml(nodes: readonly PageNode[], includeImage: (src: string) => boolean): string {
  return nodes.map((node) => {
    if (node.type === "text") return escapeHtml(node.text);
    if (node.type !== "element") return "";
    if (node.tag === "img" && !includeImage(String(node.attrs?.src))) return "";
    const attrs = Object.entries(node.attrs ?? {}).map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join("");
    if (node.tag === "img" || node.tag === "br" || node.tag === "hr") return `<${node.tag}${attrs}>`;
    return `<${node.tag}${attrs}>${renderCmsRichTextHtml(node.children, includeImage)}</${node.tag}>`;
  }).join("");
}
