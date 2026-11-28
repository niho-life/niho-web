import { cmsArray, cmsId, uniqueCmsKeys, type CmsField, type CmsItemRevision, type CmsProblem, type CmsSchema } from "./cms-v2-schema.js";
import { parsePageDocument, type PageParseOptions } from "./document.js";
import { validatePagePath } from "./pages.js";
import type { AssetReference, BlockContracts, ElementNode, PageDocument, PageNode } from "./types.js";
import { fail, identifier, keys, localeCode, parseAssetReference, record, string } from "./validation-utils.js";
import { remapCarouselBinding } from "./carousel.js";

export const cmsBindingAttributes = ["title", "aria-label", "alt", "dateTime"] as const;
type BindingAttribute = typeof cmsBindingAttributes[number];
type MappingTarget = { readonly target: "text" | "image" | "link" | "rich-text" }
  | { readonly target: "attribute"; readonly attribute: BindingAttribute }
  | { readonly target: "detail-link"; readonly path: string };
export type CmsPageFieldBinding = { readonly nodeId: string; readonly fieldId: string } & MappingTarget;
/** `equals` は値の一致、`includes` は参照・複数選択の値の配列が指定した ID を含むこと。どちらか一方だけを指定する。 */
export type CmsPageListFilter = { readonly fieldId: string; readonly equals: string } | { readonly fieldId: string; readonly includes: string };
export type CmsPageListBinding = {
  readonly templateNodeId: string;
  readonly collectionId: string;
  readonly limit: number;
  readonly filter?: CmsPageListFilter;
  readonly order?: { readonly fieldId: string; readonly direction: "asc" | "desc" };
  readonly fields: readonly CmsPageFieldBinding[];
};
/** 詳細ページの head を項目の値にする。配列は field ID を順に見て、最初の空でない値を使う。 */
export type CmsPageDetailSeo = {
  readonly title?: readonly string[];
  /** title の先頭以外の field を使ったときだけ、後ろに付ける。 */
  readonly titleSuffix?: string;
  readonly description?: readonly string[];
  /** image 型の field。 */
  readonly image?: readonly string[];
};
export type CmsPageDetailBinding = {
  readonly collectionId: string;
  readonly slugFieldId: string;
  /** 項目の URL の親。省略時はページ自身のパス。 */
  readonly basePath?: string;
  readonly seo?: CmsPageDetailSeo;
  readonly fields: readonly CmsPageFieldBinding[];
};
export type CmsPageBindingsDocument = Pick<PageDocument, "siteId" | "pageId" | "locale"> & {
  readonly schemaVersion: 1;
  readonly lists: readonly CmsPageListBinding[];
  readonly detail?: CmsPageDetailBinding;
};
export type CmsPageBindingSource = { readonly schema: CmsSchema; readonly items: readonly CmsItemRevision[] };
type Target = Pick<PageDocument, "siteId" | "pageId" | "locale">;

const LIMIT = 25;
export const CMS_PAGE_BINDINGS_MAX_BYTES = 64 * 1024;
const fieldText = new Set(["text", "longText", "slug", "datetime"]);
const textTags = new Set("div section article header footer main nav aside h1 h2 h3 h4 h5 h6 p span a li dt dd strong em b i small blockquote figure figcaption time".split(" "));
const listTags = new Set(["div", "article", "section", "li"]);
const richTextTags = new Set(["div", "article", "section"]);
/** 詳細の項目 URL の親になるパス。`basePath` があればそれ、なければページのパス。 */
export function cmsDetailBasePath(detail: Pick<CmsPageDetailBinding, "basePath"> | undefined, pagePath: string): string {
  return detail?.basePath ?? pagePath;
}
/** 項目 URL（親パス + `/{slug}`）を作れない親パスなら true。 */
export function cmsDetailBaseInvalid(basePath: string): boolean {
  return basePath === "/" || basePath === "/cms" || basePath.startsWith("/cms/") || validatePagePath(basePath + "/item") !== null;
}
const validSlug = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/u;

function fieldBindings(input: unknown, path: string): CmsPageFieldBinding[] {
  const bindings = cmsArray(input, path, 80).map((entry, index): CmsPageFieldBinding => {
    const at = path + "[" + index + "]", value = record(entry, at);
    keys(value, ["nodeId", "fieldId", "target", ...(value.target === "attribute" ? ["attribute"] : value.target === "detail-link" ? ["path"] : [])], at);
    const base = { nodeId: identifier(value.nodeId, at + ".nodeId"), fieldId: cmsId(value.fieldId, at + ".fieldId") };
    if (value.target === "text" || value.target === "image" || value.target === "link" || value.target === "rich-text") return { ...base, target: value.target };
    if (value.target === "attribute") {
      if (!cmsBindingAttributes.includes(value.attribute as BindingAttribute)) fail(at + ".attribute", "unsupported CMS attribute");
      return { ...base, target: value.target, attribute: value.attribute as BindingAttribute };
    }
    if (value.target === "detail-link") {
      const path = string(value.path, at + ".path", 200);
      if (path === "/" || validatePagePath(path + "/item") !== null) fail(at + ".path", "invalid detail page path");
      return { ...base, target: value.target, path };
    }
    return fail(at + ".target", "unsupported CMS binding target");
  });
  uniqueCmsKeys(bindings.map((binding) => binding.nodeId + "/" + (binding.target === "attribute" ? binding.attribute : binding.target === "detail-link" ? "link" : binding.target)), path);
  return bindings;
}

function parseDetailSeo(input: unknown, path: string): CmsPageDetailSeo {
  const source = record(input, path);
  keys(source, ["title", "titleSuffix", "description", "image"], path);
  const ids = (value: unknown, at: string) => {
    const list = cmsArray(value, at, 4).map((id, index) => cmsId(id, at + "[" + index + "]"));
    if (!list.length || new Set(list).size !== list.length) fail(at, "expected 1 to 4 distinct field IDs");
    return list;
  };
  const title = source.title === undefined ? undefined : ids(source.title, path + ".title");
  const description = source.description === undefined ? undefined : ids(source.description, path + ".description");
  const image = source.image === undefined ? undefined : ids(source.image, path + ".image");
  let titleSuffix: string | undefined;
  if (source.titleSuffix !== undefined) {
    titleSuffix = string(source.titleSuffix, path + ".titleSuffix", 60);
    if (!titleSuffix || /[\u0000-\u001f\u007f]/u.test(titleSuffix)) fail(path + ".titleSuffix", "invalid title suffix");
    if (!title || title.length < 2) fail(path + ".titleSuffix", "title suffix needs a title fallback field");
  }
  if (!title && !description && !image) fail(path, "SEO bindings are empty");
  return { ...(title ? { title } : {}), ...(titleSuffix === undefined ? {} : { titleSuffix }), ...(description ? { description } : {}), ...(image ? { image } : {}) };
}

export function parseCmsPageBindings(input: unknown, target?: Target): CmsPageBindingsDocument {
  const path = "$bindings", value = record(input, path);
  keys(value, ["schemaVersion", "siteId", "pageId", "locale", "lists", "detail"], path);
  if (value.schemaVersion !== 1) fail(path + ".schemaVersion", "unsupported CMS page bindings version");
  const scope = { siteId: identifier(value.siteId, path + ".siteId"), pageId: identifier(value.pageId, path + ".pageId"), locale: localeCode(value.locale, path + ".locale") };
  if (target && (scope.siteId !== target.siteId || scope.pageId !== target.pageId || scope.locale !== target.locale)) fail(path, "CMS page binding scope mismatch");
  const lists = cmsArray(value.lists, path + ".lists", 12).map((entry, index): CmsPageListBinding => {
    const at = path + ".lists[" + index + "]", source = record(entry, at);
    keys(source, ["templateNodeId", "collectionId", "limit", "filter", "order", "fields"], at);
    const limit = source.limit;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > LIMIT) fail(at + ".limit", "invalid CMS list limit");
    const value = { templateNodeId: identifier(source.templateNodeId, at + ".templateNodeId"), collectionId: cmsId(source.collectionId, at + ".collectionId"), limit,
      fields: fieldBindings(source.fields, at + ".fields") };
    const filter = source.filter === undefined ? undefined : record(source.filter, at + ".filter");
    const order = source.order === undefined ? undefined : record(source.order, at + ".order");
    if (filter) keys(filter, ["fieldId", "equals", "includes"], at + ".filter");
    if (filter && (filter.equals === undefined) === (filter.includes === undefined)) fail(at + ".filter", "filter needs exactly one of equals or includes");
    if (order) keys(order, ["fieldId", "direction"], at + ".order");
    if (order && order.direction !== "asc" && order.direction !== "desc") fail(at + ".order.direction", "invalid CMS order direction");
    return { ...value,
      ...(filter ? { filter: filter.includes === undefined
        ? { fieldId: cmsId(filter.fieldId, at + ".filter.fieldId"), equals: string(filter.equals, at + ".filter.equals", 2048) }
        : { fieldId: cmsId(filter.fieldId, at + ".filter.fieldId"), includes: string(filter.includes, at + ".filter.includes", 2048) } } : {}),
      ...(order ? { order: { fieldId: cmsId(order.fieldId, at + ".order.fieldId"), direction: order.direction as "asc" | "desc" } } : {}) };
  });
  uniqueCmsKeys(lists.map(({ templateNodeId }) => templateNodeId), path + ".lists");
  const detail = value.detail === undefined ? undefined : record(value.detail, path + ".detail");
  if (detail) keys(detail, ["collectionId", "slugFieldId", "basePath", "seo", "fields"], path + ".detail");
  const basePath = detail?.basePath === undefined ? undefined : string(detail.basePath, path + ".detail.basePath", 200);
  if (basePath !== undefined && cmsDetailBaseInvalid(basePath)) fail(path + ".detail.basePath", "invalid CMS detail base path");
  const document: CmsPageBindingsDocument = { schemaVersion: 1, ...scope, lists, ...(detail ? { detail: {
    collectionId: cmsId(detail.collectionId, path + ".detail.collectionId"),
    slugFieldId: cmsId(detail.slugFieldId, path + ".detail.slugFieldId"), ...(basePath === undefined ? {} : { basePath }),
    ...(detail.seo === undefined ? {} : { seo: parseDetailSeo(detail.seo, path + ".detail.seo") }), fields: fieldBindings(detail.fields, path + ".detail.fields")
  } } : {}) };
  if (new TextEncoder().encode(JSON.stringify(document)).byteLength > CMS_PAGE_BINDINGS_MAX_BYTES) fail(path, "CMS page bindings are too large");
  return document;
}

function elementIndex(body: readonly PageNode[], templateIds: Set<string>, parentTemplate?: string, index = new Map<string, { node: ElementNode; template?: string; nested?: true }>()) {
  for (const node of body) {
    if (node.type !== "element") continue;
    const root = templateIds.has(node.id), template = root ? node.id : parentTemplate;
    index.set(node.id, { node, ...(template ? { template } : {}), ...(root && parentTemplate ? { nested: true } : {}) });
    elementIndex(node.children, templateIds, template, index);
  }
  return index;
}

export function cmsPageFieldMatches(field: CmsField, binding: Pick<CmsPageFieldBinding, "target"> & { readonly attribute?: BindingAttribute }): boolean {
  if (binding.target === "image") return field.type === "image";
  if (binding.target === "link") return field.type === "url";
  if (binding.target === "rich-text") return field.type === "richText";
  if (binding.target === "detail-link") return field.type === "slug";
  if (binding.attribute === "dateTime") return field.type === "datetime";
  return fieldText.has(field.type);
}

function validMappingNode(node: ElementNode, binding: CmsPageFieldBinding): boolean {
  if (node.embed || node.icon) return false;
  if (binding.target === "text") return textTags.has(node.tag) && node.children.every((child) => child.type === "text");
  if (binding.target === "image") return node.tag === "img";
  // 本文は段落や見出しを含むため、区切りの要素の中身にします。元の中身は仮の文字だけにします。
  if (binding.target === "rich-text") return richTextTags.has(node.tag) && node.children.every((child) => child.type === "text");
  if (binding.target === "link" || binding.target === "detail-link") return node.tag === "a";
  if (binding.target === "attribute" && binding.attribute === "alt") return node.tag === "img";
  if (binding.target === "attribute" && binding.attribute === "dateTime") return node.tag === "time";
  return true;
}

function repeatable(node: ElementNode): boolean {
  return node.tag !== "form" && node.attrs?.id === undefined && node.children.every((child) => child.type === "text" || child.type === "element" && repeatable(child));
}

/** Reports each broken reference with the page, collection and field it affects. */
export function cmsPageBindingProblems(page: PageDocument, bindings: CmsPageBindingsDocument, schema: CmsSchema): CmsProblem[] {
  if (schema.siteId !== page.siteId || bindings.siteId !== page.siteId || bindings.pageId !== page.pageId || bindings.locale !== page.locale) fail("$bindings", "CMS page binding scope mismatch");
  const nodes = elementIndex(page.body, new Set(bindings.lists.map(({ templateNodeId }) => templateNodeId)));
  const problems: CmsProblem[] = [];
  function check(source: CmsPageListBinding | CmsPageDetailBinding, path: string) {
    const collection = schema.collections.find(({ id }) => id === source.collectionId);
    const problem = (message: string, fieldId?: string) => problems.push({ code: "binding", message, path, pageId: page.pageId, locale: page.locale,
      collectionId: source.collectionId, ...(fieldId === undefined ? {} : { fieldId }) });
    if (!collection) { problem("結び付け先のコレクションがありません。"); return; }
    const field = (id: string) => collection.fields.find(({ fieldId }) => fieldId === id);
    const template = "templateNodeId" in source ? source.templateNodeId : undefined;
    if ("templateNodeId" in source) {
      const root = nodes.get(source.templateNodeId);
      if (!root || root.nested || !listTags.has(root.node.tag) || !repeatable(root.node)) problem("繰り返す要素とその内側の要素を確認してください。");
      if (source.filter) {
        const definition = field(source.filter.fieldId), { filter } = source;
        if ("includes" in filter) {
          if (!definition || definition.type !== "reference" && !(definition.type === "select" && definition.multiple)) problem("includes は参照または複数選択のフィールドだけで使えます。", filter.fieldId);
          else if (definition.type === "select" && !definition.options.some(({ id }) => id === filter.includes)) problem("絞り込みの選択肢がフィールドにありません。", filter.fieldId);
        } else if (!definition || !(fieldText.has(definition.type) || definition.type === "select" && !definition.multiple && definition.options.some(({ id }) => id === filter.equals))) {
          problem("このフィールドは絞り込みに使えません。", filter.fieldId);
        }
      }
      if (source.order && !fieldText.has(field(source.order.fieldId)?.type ?? "")) problem("このフィールドは並べ替えに使えません。", source.order.fieldId);
    } else if (collection.slugField !== source.slugFieldId || field(source.slugFieldId)?.type !== "slug") {
      problem("詳細 URL に使うスラッグのフィールドがありません。", source.slugFieldId);
    }
    if ("seo" in source && source.seo) {
      for (const [name, ids] of [["title", source.seo.title], ["description", source.seo.description], ["image", source.seo.image]] as const) {
        for (const id of ids ?? []) {
          const definition = field(id);
          if (!definition || (name === "image" ? definition.type !== "image" : !fieldText.has(definition.type))) {
            problem("head に結び付けるフィールドがないか、型が一致しません。", id);
          }
        }
      }
    }
    for (const binding of source.fields) {
      const entry = nodes.get(binding.nodeId), definition = field(binding.fieldId);
      if (!entry || entry.template !== template || !validMappingNode(entry.node, binding)) problem("結び付け先の要素または属性が無効です。", binding.fieldId);
      if (!definition || !cmsPageFieldMatches(definition, binding)) problem("結び付け先のフィールドがないか、型が一致しません。", binding.fieldId);
    }
  }
  bindings.lists.forEach((list, index) => check(list, "$bindings.lists[" + index + "]"));
  if (bindings.detail) check(bindings.detail, "$bindings.detail");
  return problems;
}

type DetailSelection = { readonly slug: string } | { readonly itemId: string };
/** richText の値を要素へ変える処理は、HTML の解析と許可する要素を持つ host が渡します。ID は `newId` で作ります。 */
export type CmsRichTextProjection = (value: string, newId: () => string) => PageNode[];
type ProjectionOptions = { readonly detail?: DetailSelection; readonly blocks?: BlockContracts; readonly page?: PageParseOptions;
  readonly richText?: CmsRichTextProjection };

function listItems(list: CmsPageListBinding, items: readonly CmsItemRevision[], schema: CmsSchema): CmsItemRevision[] {
  const { filter } = list;
  const selected = items.filter((item) => {
    if (item.collectionId !== list.collectionId) return false;
    if (!filter) return true;
    const value = item.values[filter.fieldId];
    if ("includes" in filter) return Array.isArray(value) && value.includes(filter.includes);
    return value === filter.equals || Array.isArray(value) && value.length === 1 && value[0] === filter.equals;
  });
  const { order } = list;
  if (!order) return selected.slice(0, list.limit);
  const timestamp = schema.collections.find(({ id }) => id === list.collectionId)?.fields.find(({ fieldId }) => fieldId === order.fieldId)?.type === "datetime";
  return selected.sort((a, b) => {
    const x = a.values[order.fieldId], y = b.values[order.fieldId];
    if (typeof x !== "string" || typeof y !== "string") return Number(typeof y === "string") - Number(typeof x === "string");
    const difference = timestamp ? Math.sign(Date.parse(x) - Date.parse(y)) : x < y ? -1 : x > y ? 1 : 0;
    return order.direction === "asc" ? difference : -difference;
  }).slice(0, list.limit);
}

function applyMapping(node: ElementNode, binding: CmsPageFieldBinding, item: CmsItemRevision, richText: (value: string) => PageNode[]): void {
  const value = item.values[binding.fieldId];
  if (value === null || value === undefined) return;
  switch (binding.target) {
    case "image": {
      node.asset = parseAssetReference(value, "$binding.image");
      if (node.attrs) {
        delete node.attrs.src;
        delete node.attrs.srcSet;
      }
      return;
    }
    case "text":
      node.children = [{ type: "text", text: string(value, "$binding.text", 100000) }];
      return;
    case "rich-text":
      node.children = value === "" ? [] : richText(string(value, "$binding.richText", 2_000_000));
      return;
    case "link":
      if (value === "") {
        if (node.attrs) {
          delete node.attrs.href;
          if (Object.keys(node.attrs).length === 0) delete node.attrs;
        }
        return;
      }
      (node.attrs ??= {}).href = string(value, "$binding.link", 2048);
      return;
    case "detail-link": {
      if (typeof value !== "string" || !validSlug.test(value) || validatePagePath(binding.path + "/" + value.toLowerCase()) !== null) fail("$binding.link", "invalid CMS detail link");
      (node.attrs ??= {}).href = binding.path + "/" + value;
      return;
    }
    case "attribute":
      (node.attrs ??= {})[binding.attribute] = string(value, "$binding.attribute", 2048);
  }
}

const oneLine = (value: string): string => value.replace(/[\u0000-\u001f\u007f\s]+/gu, " ").trim();
function clip(value: string, max: number): string {
  let result = "";
  for (const character of value) { if (result.length + character.length > max) break; result += character; }
  return result;
}
/** 項目の値から head の title・description・OG 画像を選ぶ。配列の先頭から、最初の空でない値を使う。 */
function seoHead(seo: CmsPageDetailSeo, item: CmsItemRevision): { title?: string; description?: string; image?: AssetReference } {
  const text = (ids: readonly string[] | undefined) => {
    for (const [index, id] of (ids ?? []).entries()) {
      const value = item.values[id];
      const line = typeof value === "string" ? oneLine(value) : "";
      if (line) return { index, line };
    }
    return undefined;
  };
  const title = text(seo.title), description = text(seo.description);
  let image: AssetReference | undefined;
  for (const id of seo.image ?? []) {
    const value = item.values[id];
    if (value !== null && value !== undefined && value !== "") { image = parseAssetReference(value, "$binding.seoImage"); break; }
  }
  return { ...(title ? { title: clip(title.index > 0 && seo.titleSuffix ? title.line + seo.titleSuffix : title.line, 300) } : {}),
    ...(description ? { description: clip(description.line, 500) } : {}), ...(image ? { image } : {}) };
}

/** Composes renderer input using only the supplied release, or the individually authorized preview revisions. */
export function resolveCmsPageBindings(page: PageDocument, input: unknown, source: CmsPageBindingSource, options: ProjectionOptions = {}): PageDocument | null {
  const bindings = parseCmsPageBindings(input, page), { schema, items } = source;
  const problems = cmsPageBindingProblems(page, bindings, schema);
  if (problems[0]) fail(problems[0].path ?? "$bindings", problems[0].message);
  if (items.some((item) => item.siteId !== page.siteId || item.locale !== page.locale || item.schemaRevision !== schema.schemaRevision)) fail("$bindings", "CMS item scope mismatch");
  const detail = bindings.detail, selection = options.detail;
  const matching = detail && selection ? items.filter((item) => item.collectionId === detail.collectionId && ("slug" in selection
    ? item.values[detail.slugFieldId] === selection.slug : item.itemId === selection.itemId)) : [];
  if (matching.length > 1) fail("$bindings.detail", "ambiguous CMS detail item");
  if (detail && !matching.length) return null;
  const detailItem = matching[0];
  const lists = new Map(bindings.lists.map((list) => [list.templateNodeId, list]));
  const used = new Set<string>();
  function collectIds(nodes: readonly PageNode[]) {
    for (const node of nodes) {
      if (node.type === "text") continue;
      used.add(node.id);
      if (node.type === "element") collectIds(node.children);
    }
  }
  collectIds(page.body);
  let counter = 0, count = 0;
  function newId(): string {
    let id: string;
    do { id = "cms-item-" + ++counter; } while (used.has(id));
    used.add(id);
    return id;
  }
  function richText(value: string): PageNode[] {
    return options.richText ? options.richText(value, newId) : fail("$bindings", "CMS rich-text binding requires a rich-text projection");
  }
  function projectNode(node: PageNode, item: CmsItemRevision | undefined, fields: readonly CmsPageFieldBinding[], repeated: Map<string, string> | undefined): PageNode {
    if (++count > 5000) fail("$bindings", "CMS page exceeds the node limit");
    if (node.type !== "element") return node;
    const copy: ElementNode = { ...node, id: repeated ? newId() : node.id, ...(node.attrs ? { attrs: { ...node.attrs } } : {}),
      children: project(node.children, item, fields, repeated) };
    if (repeated) {
      repeated.set(node.id, copy.id);
      if (copy.interaction?.type === "carousel") {
        copy.interaction = { type: "carousel", binding: remapCarouselBinding(copy.interaction.binding, (id) => repeated.get(id) ?? id) };
      }
    }
    if (item) for (const binding of fields) if (binding.nodeId === node.id) applyMapping(copy, binding, item, richText);
    return copy;
  }
  function project(nodes: readonly PageNode[], item: CmsItemRevision | undefined, fields: readonly CmsPageFieldBinding[], repeated: Map<string, string> | undefined): PageNode[] {
    return nodes.flatMap((node) => {
      const list = node.type === "element" ? lists.get(node.id) : undefined;
      return list ? listItems(list, items, schema).map((entry) => projectNode(node, entry, list.fields, new Map())) : [projectNode(node, item, fields, repeated)];
    });
  }
  const body = project(page.body, detailItem, detail?.fields ?? [], undefined);
  const head = detail?.seo && detailItem ? seoHead(detail.seo, detailItem) : {};
  const meta = head.description !== undefined || head.image ? { ...page.meta, ...(head.description === undefined ? {} : { description: head.description }),
    ...(head.image ? { ogImage: { asset: head.image, alt: clip(oneLine(head.title ?? page.title), 300) } } : {}) } : page.meta;
  return parsePageDocument({ ...page, ...(head.title === undefined ? {} : { title: head.title }), ...(meta ? { meta } : {}), body }, options.blocks, options.page);
}
