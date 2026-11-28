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
type Context = { readonly phrasing: boolean; readonly link: boolean; readonly depth: number };

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const MAX_DEPTH = 24;
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

export function cmsRichTextNodes(html: string, newId: () => string): PageNode[] {
  const headingIds = new Set<string>();
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

  function link(source: SourceElement, context: Context): PageNode[] {
    const href = attribute(source, "href")?.trim();
    if (context.link || !href || !isSafePublicLink(href)) return convert(source.childNodes, context);
    const attrs: ElementAttributes = { href };
    const rel = (attribute(source, "rel") ?? "").split(/\s+/u).filter((token) => REL.test(token));
    if (attribute(source, "target") === "_blank") {
      attrs.target = "_blank";
      if (!rel.includes("noopener")) rel.push("noopener");
    }
    if (rel.length) attrs.rel = [...new Set(rel)].join(" ");
    return [element("a", convert(source.childNodes, { phrasing: true, link: true, depth: context.depth + 1 }), attrs)];
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
        items.push(element("li", convert(node.childNodes, { ...context, depth: context.depth + 1 })));
      } else loose.push(...convert([node], { ...context, depth: context.depth + 1 }));
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
      if (context.depth >= MAX_DEPTH) return convert(node.childNodes, context);
      if (name === "br") return [element("br", [])];
      if (name === "hr") return context.phrasing ? [] : [element("hr", [])];
      if (name === "img") return image(node);
      if (name === "a") return link(node, context);
      if (name === "td" || name === "th") return [...convert(node.childNodes, context), { type: "text", text: " " }];
      const inline = INLINE.get(name);
      if (inline) return [element(inline, convert(node.childNodes, { ...context, phrasing: true, depth: context.depth + 1 }))];
      // li は一覧の中でだけ使えます。一覧の外に置かれた li は区切りの要素にします。
      const block = name === "li" ? "div" : BLOCKS.get(name);
      if (!block || context.phrasing) return convert(node.childNodes, context);
      if (block === "ul" || block === "ol") {
        const items = listItems(node.childNodes, context);
        return items.length ? [element(block, items)] : [];
      }
      const attrs: ElementAttributes = {};
      const id = attribute(node, "id");
      if (/^h[2-4]$/u.test(block) && id && HEADING_ID.test(id) && !headingIds.has(id)) {
        headingIds.add(id);
        attrs.id = id;
      }
      return [element(block, convert(node.childNodes, { phrasing: TEXT_ONLY.has(block), link: context.link, depth: context.depth + 1 }), attrs)];
    });
  }

  return convert(parseFragment(html).childNodes, { phrasing: false, link: false, depth: 0 });
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
