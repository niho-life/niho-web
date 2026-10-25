/**
 * Studio の本文の編集（TipTap）の拡張と、触っていない所を書き換えない書き出し。
 * 拡張は鎌倉の管理画面の本文（kamakura-site の src/admin/rich.ts）と同じ形で、STUDIO の本文（HTML）をそのまま読み書きする:
 *   画像 <figure style><a href target rel>?<img src alt width height></a>?<figcaption>…</figcaption></figure>
 *   段落の中の画像 <img>・見出しの id（目次の飛び先）・目次の置き場 <div></div>・埋め込み <div data-type="embed_code">（と iframe・表）
 */
import { Extension, Node as TiptapNode, textblockTypeInputRule, type Extensions } from "@tiptap/core";
import Heading from "@tiptap/extension-heading";
import { Placeholder } from "@tiptap/extensions";
import { DOMParser as ProseMirrorDOMParser, DOMSerializer, Fragment, type Node as ProseMirrorNode, type ParseOptions, type Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { HEADING_ID, studioRichTextHref } from "./rich-text-sanitize.js";

export type RichTextSchemaOptions = {
  /** 編集画面で画像を出す URL。出してよくない src なら null（画像を出さない）。 */
  readonly displayImage: (src: string) => string | null;
  /** 埋め込み・表の HTML を読み込むときに通す無害化。 */
  readonly sanitize: (html: string) => string;
  /** 本文が空のときに出す案内。 */
  readonly placeholder: string;
};

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** STUDIO の見出しの id と同じ形の乱数（英数字）。 */
export function randomId(length: number): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("");
}

/** null の属性は出さない（空の文字は出す。既存の本文の width="" などを保つ）。 */
const attrs = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null && value !== undefined)) as Record<string, string>;
/**
 * figure の style は書き出しのときだけ別の名前で持つ。ProseMirror は style を CSSOM（style.cssText）で入れるので、
 * そのままだと "text-align: " が "" になるなど書き方が変わる。serializeNodes が元の文字のまま style に戻す。
 */
const STYLE_SLOT = "data-studio-style";
/** リンクの属性の並び（STUDIO の本文は target・href・rel の順が多い）。直した段でも元の並びで書き出すために持つ。 */
const ORDER_SLOT = "data-studio-order";
const AttributeOrder = Extension.create({
  name: "studioAttributeOrder",
  addGlobalAttributes() {
    return [{
      types: ["link"],
      attributes: {
        attributeOrder: {
          default: null,
          parseHTML: (element: HTMLElement) => Array.from(element.attributes, (attribute) => attribute.name).filter((name) => name !== ORDER_SLOT).join(" ") || null,
          renderHTML: (values: { attributeOrder?: string | null }) => (values.attributeOrder ? { [ORDER_SLOT]: values.attributeOrder } : {}),
        },
      },
    }];
  },
});
const read = (element: HTMLElement | null | undefined, name: string) => element?.getAttribute(name) ?? null;

// 見出し: 「# 」「## 」→ 見出し（h2）・「### 」→ 小見出し（h3）。読むのは h1〜h4（既存の記事に h1 がある）。
// id（目次の飛び先・STUDIO と同じ index_xxxxxxxx）を持ち、無い見出し・重なった id・使えない id には直したときに付け直す
const Head = Heading.extend({
  addAttributes() {
    return { ...this.parent?.(), id: { default: null, parseHTML: (element: HTMLElement) => element.getAttribute("id"), renderHTML: (values: { id?: string | null }) => (values.id ? { id: values.id } : {}) } };
  },
  addInputRules() {
    return [
      textblockTypeInputRule({ find: /^(#{1,2})\s$/u, type: this.type, getAttributes: () => ({ level: 2 }) }),
      textblockTypeInputRule({ find: /^###\s$/u, type: this.type, getAttributes: () => ({ level: 3 }) }),
    ];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("studioHeadingIds"),
        appendTransaction: (transactions, _old, state) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          const seen = new Set<string>();
          let tr: Transaction | null = null;
          state.doc.descendants((node, pos) => {
            if (node.type.name !== "heading") return;
            const id = node.attrs.id as string | null;
            if (id && HEADING_ID.test(id) && !seen.has(id)) { seen.add(id); return; }
            const fresh = `index_${randomId(8)}`;
            seen.add(fresh);
            tr = (tr ?? state.tr).setNodeMarkup(pos, undefined, { ...node.attrs, id: fresh });
          });
          return tr;
        },
      }),
    ];
  },
}).configure({ levels: [1, 2, 3, 4] });

// 画像＋説明（STUDIO の本文の画像と同じ形）。上げている間は uploading に印を持ち、書き出しには入れない
const Figure = TiptapNode.create<{ displayImage: (src: string) => string | null }>({
  name: "figure",
  group: "block",
  content: "inline*",
  draggable: true,
  isolating: true,
  addOptions() { return { displayImage: (src: string) => src }; },
  addAttributes() {
    const img = (element: HTMLElement) => element.querySelector("img");
    return {
      src: { default: null, parseHTML: (element: HTMLElement) => read(img(element), "src") },
      alt: { default: "", parseHTML: (element: HTMLElement) => read(img(element), "alt") ?? "" },
      width: { default: null, parseHTML: (element: HTMLElement) => read(img(element), "width") },
      height: { default: null, parseHTML: (element: HTMLElement) => read(img(element), "height") },
      style: { default: null, parseHTML: (element: HTMLElement) => element.getAttribute("style") },
      href: { default: null, parseHTML: (element: HTMLElement) => read(img(element)?.closest("a"), "href") },
      target: { default: null, parseHTML: (element: HTMLElement) => read(img(element)?.closest("a"), "target") },
      rel: { default: null, parseHTML: (element: HTMLElement) => read(img(element)?.closest("a"), "rel") },
      // 本文の属性からは読まない（読むと、その画像が書き出しから消えてしまう）
      uploading: { default: null, rendered: false, parseHTML: () => null },
    };
  },
  parseHTML() {
    return [{
      tag: "figure",
      contentElement: (element: HTMLElement) => element.querySelector("figcaption") ?? element.ownerDocument.createElement("figcaption"),
      getAttrs: (element: HTMLElement) => (element.querySelector("img") ? {} : false),
    }];
  },
  renderHTML({ node }) {
    const a = node.attrs;
    const img = ["img", attrs({ src: a.src, alt: a.alt ?? "", width: a.width, height: a.height })];
    return ["figure", attrs({ [STYLE_SLOT]: a.style }), a.href ? ["a", attrs({ href: a.href, target: a.target, rel: a.rel }), img] : img, ["figcaption", 0]] as never;
  },
  addNodeView() {
    const display = this.options.displayImage;
    return ({ node }) => {
      const dom = document.createElement("figure"), img = document.createElement("img"), busy = document.createElement("span"), caption = document.createElement("figcaption");
      img.contentEditable = "false";
      img.draggable = false;
      busy.className = "studio-rich-busy";
      busy.contentEditable = "false";
      busy.textContent = "画像を上げています…";
      let shown: string | null = null;
      const paint = (next: ProseMirrorNode) => {
        const src = typeof next.attrs.src === "string" ? display(next.attrs.src) : null;
        if (src !== shown) { if (src) img.src = src; else img.removeAttribute("src"); shown = src; }
        img.alt = String(next.attrs.alt ?? "");
        img.hidden = !src;
        dom.classList.toggle("is-uploading", !!next.attrs.uploading);
        dom.classList.toggle("is-linked", !!next.attrs.href);
        busy.hidden = !next.attrs.uploading;
      };
      paint(node);
      dom.append(img, busy, caption);
      return {
        dom,
        contentDOM: caption,
        update: (next) => next.type.name === "figure" ? (paint(next), true) : false,
        ignoreMutation: (mutation) => !caption.contains(mutation.target),
      };
    };
  },
});

// 段落の中の画像（既存の記事にある）
const InlineImage = TiptapNode.create<{ displayImage: (src: string) => string | null }>({
  name: "inlineImage",
  group: "inline",
  inline: true,
  atom: true,
  addOptions() { return { displayImage: (src: string) => src }; },
  addAttributes() {
    return {
      src: { default: null, parseHTML: (element: HTMLElement) => element.getAttribute("src") },
      alt: { default: "", parseHTML: (element: HTMLElement) => element.getAttribute("alt") ?? "" },
      width: { default: null, parseHTML: (element: HTMLElement) => element.getAttribute("width") },
      height: { default: null, parseHTML: (element: HTMLElement) => element.getAttribute("height") },
    };
  },
  parseHTML() { return [{ tag: "img[src]" }]; },
  renderHTML({ node }) {
    return ["img", attrs({ src: node.attrs.src, alt: node.attrs.alt ?? "", width: node.attrs.width, height: node.attrs.height })];
  },
  addNodeView() {
    const display = this.options.displayImage;
    return ({ node }) => {
      const img = document.createElement("img"), src = typeof node.attrs.src === "string" ? display(node.attrs.src) : null;
      if (src) img.src = src;
      img.alt = String(node.attrs.alt ?? "");
      img.className = "studio-rich-inline-image";
      return { dom: img };
    };
  },
});

/** 埋め込み（SNS・地図など）と、本文の部品に無い塊（表・iframe）。無害化した HTML をそのまま持ち、そのまま書き戻す */
const RawBlock = TiptapNode.create<{ sanitize: (html: string) => string }>({
  name: "rawBlock",
  group: "block",
  atom: true,
  draggable: true,
  addOptions() { return { sanitize: (html: string) => html }; },
  addAttributes() {
    // 要素の属性からは読まない（html="…" を持つ要素で無害化を飛ばさないため）
    return { html: { default: "", parseHTML: () => null } };
  },
  parseHTML() {
    const keep = (element: HTMLElement) => {
      const html = this.options.sanitize(element.outerHTML);
      return html ? { html } : false;
    };
    return [
      { tag: 'div[data-type="embed_code"]', priority: 70, getAttrs: keep },
      { tag: "iframe", getAttrs: keep },
      { tag: "table", getAttrs: keep },
    ];
  },
  renderHTML({ node }) {
    const template = document.createElement("template");
    template.innerHTML = String(node.attrs.html ?? "");
    return (template.content.firstElementChild ?? document.createElement("div")) as never;
  },
  addNodeView() {
    return ({ node }) => {
      const html = String(node.attrs.html);
      const kind = /instagram/iu.test(html) ? "Instagram" : /youtu/iu.test(html) ? "YouTube" : /google\.[a-z.]+\/maps/iu.test(html) ? "Google マップ" : /^<table/iu.test(html) ? "表" : "外部のサービス";
      const dom = document.createElement("div");
      dom.className = "studio-rich-embed";
      dom.contentEditable = "false";
      dom.textContent = kind === "表" ? "表。公開したページでだけ表として出ます（ここでは直せません）。" : `埋め込み（${kind}）。中身は公開したページでだけ出ます。`;
      return { dom };
    };
  },
});

/** 目次の置き場（STUDIO の本文の空の <div></div>）。公開したページでは、見出しから目次を作って出す */
const Toc = TiptapNode.create({
  name: "toc",
  group: "block",
  atom: true,
  draggable: true,
  parseHTML() {
    return [{ tag: "div", priority: 60, getAttrs: (element: HTMLElement) => (element.childNodes.length === 0 && element.attributes.length === 0 ? {} : false) }];
  },
  renderHTML() { return ["div"]; },
  addNodeView() {
    return ({ editor }) => {
      const dom = document.createElement("div");
      dom.className = "studio-rich-toc";
      dom.contentEditable = "false";
      const paint = () => {
        const title = document.createElement("b"), list = document.createElement("ul");
        title.textContent = "目次";
        editor.state.doc.descendants((node) => {
          if (node.type.name !== "heading" || node.attrs.level < 2) return;
          const item = document.createElement("li");
          item.className = `lv${node.attrs.level}`;
          item.textContent = node.textContent || "（空の見出し）";
          list.append(item);
        });
        if (!list.childElementCount) { const empty = document.createElement("li"); empty.textContent = "見出しを足すと、ここに目次が出ます"; list.append(empty); }
        dom.replaceChildren(title, list);
      };
      paint();
      editor.on("update", paint);
      return { dom, destroy: () => { editor.off("update", paint); } };
    };
  },
});

/** 鎌倉の管理画面の本文と同じ拡張。 */
export function createRichTextExtensions(options: RichTextSchemaOptions): Extensions {
  return [
    StarterKit.configure({
      heading: false,
      codeBlock: false,
      // 既存のリンクの target・rel は読んだまま書き戻す（無いものに足さない）。新しいリンクの target は道具の側で付ける
      link: { openOnClick: false, autolink: true, HTMLAttributes: { target: null, rel: null, class: null }, isAllowedUri: (url) => studioRichTextHref(url) !== null },
      dropcursor: { color: "#2c6bdc", width: 3 },
    }),
    Head,
    Figure.configure({ displayImage: options.displayImage }),
    InlineImage.configure({ displayImage: options.displayImage }),
    RawBlock.configure({ sanitize: options.sanitize }),
    Toc,
    AttributeOrder,
    Placeholder.configure({
      includeChildren: true,
      placeholder: ({ node, editor }) => (node.type.name === "paragraph" && editor.isEmpty ? options.placeholder : ""),
    }),
  ];
}

/* ---------- 触っていない所を書き換えない書き出し ---------- */

type Segment = { readonly html: string; readonly nodes: readonly ProseMirrorNode[] };
export type RichTextBaseline = {
  /** 読み込んだ値（そのまま）。 */
  readonly original: string;
  /** 元に戻ったときに渡す値。無害化しても変わらないなら original、変わるなら無害化したもの。 */
  readonly restored: string;
  /** 読み込んだ直後の本文（上の段の並び）。 */
  readonly nodes: readonly ProseMirrorNode[];
  /** 上の段ごとの元の HTML と本文。元の HTML と本文の対応が取れないときは null（直したら全体を書き出す）。 */
  readonly segments: readonly Segment[] | null;
  /** 読み込んだ直後の、末尾の空の段落の数。 */
  readonly trailingEmpty: number;
};

const INLINE = new Set(["a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "del", "dfn", "em", "font", "i", "img", "ins", "kbd", "mark", "q", "s", "samp", "small", "span", "strike", "strong", "sub", "sup", "time", "u", "var", "wbr"]);
/** TipTap の elementFromString と同じく、改行だけの文字を除く（同じ DOM から本文を作るため）。 */
function removeWhitespaces(node: Element): Element {
  for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
    const child = node.childNodes[index]!;
    if (child.nodeType === 3 && child.nodeValue && /^(\n\s\s|\n)$/u.test(child.nodeValue)) node.removeChild(child);
    else if (child.nodeType === 1) removeWhitespaces(child as Element);
  }
  return node;
}
const isEmptyParagraph = (node: ProseMirrorNode) => node.type.name === "paragraph" && node.content.size === 0;
const trailingEmpty = (nodes: readonly ProseMirrorNode[]) => { let count = 0; for (let index = nodes.length - 1; index >= 0 && isEmptyParagraph(nodes[index]!); index -= 1) count += 1; return count; };
const sameNodes = (a: readonly ProseMirrorNode[], b: readonly ProseMirrorNode[]) => a.length === b.length && a.every((node, index) => node.eq(b[index]!));
const childrenOf = (node: ProseMirrorNode) => { const list: ProseMirrorNode[] = []; node.forEach((child) => list.push(child)); return list; };

/** 上げている途中の画像を除いた本文（書き出しに入れない）。 */
function withoutUploads(node: ProseMirrorNode): ProseMirrorNode {
  let found = false;
  node.descendants((child) => { if (child.type.name === "figure" && child.attrs.uploading) found = true; return !found; });
  if (!found) return node;
  const children: ProseMirrorNode[] = [];
  node.forEach((child) => { if (!(child.type.name === "figure" && child.attrs.uploading)) children.push(withoutUploads(child)); });
  return node.copy(Fragment.fromArray(children));
}

/** 本文の並びを HTML にする。部品は表示しない文書（createHTMLDocument）の中で作る（CSP の inline style に当たらない）。 */
export function serializeNodes(nodes: readonly ProseMirrorNode[], schema: Schema): string {
  if (!nodes.length) return "";
  const doc = document.implementation.createHTMLDocument(""), box = doc.createElement("div");
  box.append(DOMSerializer.fromSchema(schema).serializeFragment(Fragment.fromArray([...nodes]), { document: doc }));
  for (const element of Array.from(box.querySelectorAll(`[${STYLE_SLOT}]`))) {
    element.setAttribute("style", element.getAttribute(STYLE_SLOT) ?? "");
    element.removeAttribute(STYLE_SLOT);
  }
  for (const element of Array.from(box.querySelectorAll(`[${ORDER_SLOT}]`))) {
    const order = (element.getAttribute(ORDER_SLOT) ?? "").split(" ");
    element.removeAttribute(ORDER_SLOT);
    const rank = (name: string) => { const index = order.indexOf(name); return index < 0 ? order.length : index; };
    const sorted = Array.from(element.attributes, (attribute) => [attribute.name, attribute.value] as const).sort((a, b) => rank(a[0]) - rank(b[0]));
    for (const [name] of sorted) element.removeAttribute(name);
    for (const [name, value] of sorted) element.setAttribute(name, value);
  }
  return box.innerHTML;
}

/**
 * 読み込んだ値と、それを読んだ本文（editor.state.doc）から、書き出しの基準を作る。
 * 元の HTML を上の段（ブロック 1 つ、または続いた文字・インラインの要素）ごとに分け、それぞれを同じ規則で読んだ本文と対応させる。
 */
export function createBaseline(original: string, doc: ProseMirrorNode, schema: Schema, sanitize: (html: string) => string, isSafe: (html: string) => boolean): RichTextBaseline {
  const nodes = childrenOf(doc);
  const restored = !original || isSafe(original) ? original : sanitize(original);
  const base = { original, restored, nodes, trailingEmpty: trailingEmpty(nodes) };
  if (!original) return { ...base, segments: null };
  const body = new window.DOMParser().parseFromString(`<body>${original}</body>`, "text/html").body;
  const parser = ProseMirrorDOMParser.fromSchema(schema);
  const groups: Node[][] = [];
  let run: Node[] | null = null;
  for (const child of Array.from(body.childNodes)) {
    const inline = child.nodeType === 3 || (child.nodeType === 1 && INLINE.has((child as Element).localName.toLowerCase()));
    if (inline) { if (!run) { run = []; groups.push(run); } run.push(child); continue; }
    run = null;
    groups.push([child]);
  }
  const segments: Segment[] = groups.map((group) => {
    const box = body.ownerDocument.createElement("div");
    for (const child of group) box.append(child.cloneNode(true));
    const html = box.innerHTML;
    // 上の段の本文だけを、全体を読むときと同じ規則で読む。topOpen（prosemirror-model の内部の option）で、空の段に段落を足さない。
    // 無くなっても、対応が取れずに全体を書き出す側へ倒れるだけ（テストが気づく）
    const parsed = parser.parse(removeWhitespaces(box), { topOpen: true } as ParseOptions);
    return { html, nodes: childrenOf(parsed) };
  });
  const flat = segments.flatMap((segment) => segment.nodes);
  return { ...base, segments: sameNodes(flat, nodes) ? segments : null };
}

/**
 * いまの本文を HTML にする。元に戻っていれば読み込んだ値を、直した所があれば、前と後ろの変わっていない段は元の HTML のまま、
 * 間だけを書き出して、全体を無害化して返す。本文が空なら ""。
 */
export function serializeRichText(doc: ProseMirrorNode, baseline: RichTextBaseline, schema: Schema, sanitize: (html: string) => string): string {
  const current = childrenOf(withoutUploads(doc));
  // TrailingNode が末尾に足す空の段落は書き出さない（読み込んだときにあった数までは残す）
  while (trailingEmpty(current) > baseline.trailingEmpty) current.pop();
  if (sameNodes(current, baseline.nodes)) return baseline.restored;
  if (current.length === 0 || current.every(isEmptyParagraph)) return "";
  const serialize = (nodes: readonly ProseMirrorNode[]) => serializeNodes(nodes, schema);
  const segments = baseline.segments;
  if (!segments) return sanitize(serialize(current));

  const original = baseline.nodes, limit = Math.min(original.length, current.length);
  let prefix = 0;
  while (prefix < limit && original[prefix]!.eq(current[prefix]!)) prefix += 1;
  let suffix = 0;
  while (suffix < limit - prefix && original[original.length - 1 - suffix]!.eq(current[current.length - 1 - suffix]!)) suffix += 1;

  // 段ごとの範囲 [start, end)。全部が前の一致の中にある段は前、後ろの一致の中にある段は後ろとして元の HTML のまま出す
  let start = 0;
  const ranges = segments.map((segment) => { const range = { segment, start, end: start + segment.nodes.length }; start = range.end; return range; });
  let head = 0, headNodes = 0;
  while (head < ranges.length && ranges[head]!.end <= prefix) { headNodes = ranges[head]!.end; head += 1; }
  let tail = ranges.length, tailNodes = 0;
  const tailFrom = original.length - suffix;
  while (tail > head && ranges[tail - 1]!.start >= tailFrom) { tail -= 1; tailNodes = original.length - ranges[tail]!.start; }
  const middle = current.slice(headNodes, current.length - tailNodes);
  const html = ranges.slice(0, head).map((range) => range.segment.html).join("") + serialize(middle) + ranges.slice(tail).map((range) => range.segment.html).join("");
  return sanitize(html);
}
