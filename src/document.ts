import { mergeSiteStyles, parseSiteStyles, resolvePageStyles, type SiteStyles } from "./site-styles.js";
import type {
  BlockContract, BlockContracts, BlockSlot, ComponentLibrary, ComponentPropField, DesignToken, ElementAttributes, ElementInteraction, ElementNode, ElementTag, NodeStyle, PageDocument, PageImage, PageMeta, PageNode, PropRule, PublicPropValue, TextStyle
} from "./types.js";
import { COMPONENT_LIMITS, expandDocument, instancesOf } from "./component-expand.js";
import { isStyleProperty, parseStyle, parseTextStyles, parseTokens } from "./style-values.js";
import { DocumentValidationError, fail, identifier, isSafePublicLink, isSafePublicUrl, keys, line, localeCode, parseAssetReference, publicImageSrcSet, publicImageUrl, record, string } from "./validation-utils.js";
import { isIconName } from "./icons.js";
import { parseEmbedDescriptor } from "./embeds.js";

const tags = new Set("div section article header footer main nav aside h1 h2 h3 h4 h5 h6 p span a img picture source video ul ol li dl dt dd strong em b i small blockquote figure figcaption br hr time details summary form label input textarea select option button fieldset legend".split(" "));
const voidTags = new Set(["img", "source", "br", "hr", "input"]);
const phrasing = new Set("span a img strong em b i small br time label input textarea select button".split(" "));
const phrasingParents = new Set("p span h1 h2 h3 h4 h5 h6 a strong em b i small time summary label button option legend".split(" "));
// 開閉（details / summary）は JS なしで動く。summary の中にリンクや入れ子の開閉は置けない。
const interactive = new Set(["a", "video", "details", "summary", "label", "input", "textarea", "select", "button"]);
const globalAttributes = ["id", "title", "lang", "dir", "role", "hidden", "tabIndex", "aria-label", "aria-labelledby", "aria-describedby", "aria-hidden", "aria-current", "aria-pressed"];
const tagAttributes: Partial<Record<ElementTag, string[]>> = {
  a: ["href", "target", "rel", "hrefLang"], img: ["src", "srcSet", "alt", "width", "height", "loading", "decoding"],
  source: ["srcSet", "type", "media"], video: ["src", "poster", "width", "height", "controls", "loop", "muted", "preload", "playsInline"],
  ol: ["start", "reversed"], li: ["value"], time: ["dateTime"], details: ["open"],
  form: ["name", "autocomplete"], label: ["htmlFor"],
  input: ["type", "name", "placeholder", "required", "value", "checked", "disabled", "autocomplete", "accept"],
  textarea: ["name", "placeholder", "required", "disabled", "autocomplete", "rows"],
  select: ["name", "required", "disabled", "autocomplete"], option: ["value", "disabled"],
  button: ["type", "name", "value", "disabled"], fieldset: ["name", "disabled"]
};
function attributes(value: unknown, tag: ElementTag, path: string, asset = false): ElementAttributes {
  const source = record(value, path), result: ElementAttributes = {};
  keys(source, [...globalAttributes, ...(tagAttributes[tag] ?? [])], path);
  for (const [name, value] of Object.entries(source)) {
    const at = `${path}.${name}`;
    if (["hidden", "reversed", "open", "controls", "loop", "muted", "playsInline", "required", "checked", "disabled"].includes(name)) {
      if (typeof value !== "boolean") fail(at, "expected boolean");
    } else if (["width", "height", "start", "tabIndex", "rows"].includes(name) || name === "value" && tag === "li") {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || Math.abs(value) > 100000 ||
          (["width", "height", "rows"].includes(name) && value <= 0) || (name === "rows" && value > 100) || (name === "tabIndex" && ![-1, 0].includes(value))) fail(at, "invalid integer attribute");
    } else {
      const text = string(value, at, 2048);
      if (name === "href" && !isSafePublicLink(text)) fail(at, "unsafe URL");
      if (name === "src") publicImageUrl(text, at);
      if (name === "poster") publicImageUrl(text, at);
      if (name === "srcSet") publicImageSrcSet(text, at);
      if (name === "media" && !/^\((?:min|max)-width: [1-9]\d{1,3}px\)$/.test(text)) fail(at, "unsupported media condition");
      if (name === "type" && tag === "source" && !["image/avif", "image/webp", "image/png", "image/jpeg"].includes(text)) fail(at, "unsupported image type");
      if (name === "type" && tag === "input" && !["text", "email", "tel", "radio", "checkbox", "file", "submit", "search", "password"].includes(text)) fail(at, "unsupported input type");
      if (name === "type" && tag === "button" && !["button", "submit"].includes(text)) fail(at, "unsupported button type");
      if (name === "id") identifier(text, at);
      if (name === "name" && !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(text)) fail(at, "invalid form identifier");
      if (name === "htmlFor" && !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(text)) fail(at, "invalid form identifier");
      if (name === "placeholder" && (text.length > 300 || /[\u0000-\u001f\u007f]/u.test(text))) fail(at, "invalid placeholder");
      if (name === "value" && text.length > 500) fail(at, "form value is too long");
      if (name === "autocomplete" && !["on", "off", "name", "email", "tel", "current-password", "new-password"].includes(text)) fail(at, "unsupported autocomplete value");
      if (name === "accept" && (tag !== "input" || !/^(?:[a-z]+\/[a-z0-9.+*-]+|\.[a-z0-9]+)(?:\s*,\s*(?:[a-z]+\/[a-z0-9.+*-]+|\.[a-z0-9]+)){0,15}$/i.test(text))) fail(at, "invalid file accept list");
      if (["aria-labelledby", "aria-describedby"].includes(name) && !/^[A-Za-z][A-Za-z0-9_-]*(?: [A-Za-z][A-Za-z0-9_-]*)*$/.test(text)) fail(at, "invalid ID references");
      if (name === "aria-hidden" && !["true", "false"].includes(text)) fail(at, "invalid aria-hidden");
      if (name === "aria-pressed" && tag !== "button") fail(at, "aria-pressed requires a button");
      if (name === "aria-pressed" && !["true", "false"].includes(text)) fail(at, "invalid aria-pressed");
      if (name === "aria-current" && !["page", "step", "location", "date", "time", "true", "false"].includes(text)) fail(at, "invalid aria-current");
      if (name === "target" && !["_blank", "_self"].includes(text)) fail(at, "unsupported target");
      if (name === "rel" && !/^(?:noopener|noreferrer|nofollow|sponsored|ugc)(?: (?:noopener|noreferrer|nofollow|sponsored|ugc))*$/.test(text)) fail(at, "unsupported rel");
      if (name === "dir" && !["ltr", "rtl", "auto"].includes(text)) fail(at, "invalid direction");
      if (name === "lang" && !/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(text)) fail(at, "invalid language");
      if (name === "role" && !["banner", "navigation", "main", "contentinfo", "complementary", "region", "group", "list", "listitem", "img", "presentation", "none", "note"].includes(text)) fail(at, "unsupported role");
      if (name === "loading" && !["lazy", "eager"].includes(text)) fail(at, "invalid loading");
      if (name === "decoding" && !["async", "sync", "auto"].includes(text)) fail(at, "invalid decoding");
      if (name === "preload" && !["none", "metadata", "auto"].includes(text)) fail(at, "invalid preload");
    }
    result[name] = value as string | number | boolean;
  }
  if (tag === "img" && asset && (Object.hasOwn(result, "src") || Object.hasOwn(result, "srcSet"))) fail(path, "img uses either URL sources or asset");
  if (tag === "img" && (!asset && typeof result.src !== "string" || typeof result.alt !== "string")) fail(path, asset ? "img requires alt" : "img requires src and alt");
  if (tag === "video" && asset && Object.hasOwn(result, "src")) fail(path, "video uses either URL source or asset");
  if (tag === "video" && ![result["aria-label"], result.title].some((label) => typeof label === "string" && !!label.trim())) fail(path, "video requires an accessible label");
  if (tag === "form" && typeof result.name !== "string") fail(path, "form requires name");
  if (tag === "label" && typeof result.htmlFor !== "string") fail(path, "label requires htmlFor");
  if (tag === "fieldset" && typeof result.name !== "string") fail(path, "radio fieldset requires name");
  if (tag === "textarea" || tag === "select" || tag === "input" && result.type !== "submit") {
    if (typeof result.name !== "string") fail(path, "form control requires name");
  }
  if (tag === "input") {
    const type = String(result.type ?? "text");
    if (result.type === undefined) result.type = "text";
    if ((type === "password" || type === "file") && Object.hasOwn(result, "value")) fail(path, "password and file values cannot be persisted");
    if (Object.hasOwn(result, "checked") && !["radio", "checkbox"].includes(type)) fail(path, "checked is only valid for radio and checkbox");
    if (Object.hasOwn(result, "accept") && type !== "file") fail(path, "accept is only valid for file inputs");
  }
  if (tag === "button" && result.type === undefined) result.type = "button";
  return result;
}

function prop(value: unknown, rule: PropRule, path: string): PublicPropValue {
  switch (rule.type) {
    case "string": return string(value, path, Math.min(rule.maxLength ?? 4096, 4096));
    case "url": {
      if (!isSafePublicUrl(value)) fail(path, "unsafe URL prop");
      return value;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value) || value < (rule.min ?? -Number.MAX_SAFE_INTEGER) || value > (rule.max ?? Number.MAX_SAFE_INTEGER)) fail(path, "invalid numeric prop");
      return value;
    }
    case "boolean": {
      if (typeof value !== "boolean") fail(path, "expected boolean prop");
      return value;
    }
    case "enum": {
      if (typeof value !== "string" || !rule.values.includes(value)) fail(path, "invalid enum prop");
      return value;
    }
    default: return fail(path, "unsupported prop contract");
  }
}

export const metaLimits = { descriptionLength: 500, altLength: 300, structuredData: 16 } as const;
/** HTTPS か / から始まる同一サイト内のパス。#id は画像・アイコンに使えない。 */
function assetUrl(value: unknown, path: string): string {
  return publicImageUrl(value, path);
}
/** src（URL）か asset（素材参照）のどちらか一方を持つ。 */
export function parsePageImage(input: unknown, path: string): PageImage {
  const source = record(input, path);
  keys(source, ["src", "asset", "alt"], path);
  if ((source.src === undefined) === (source.asset === undefined)) fail(path, "image uses either src or asset");
  const alt = line(source.alt, `${path}.alt`, metaLimits.altLength, true);
  return source.asset === undefined ? { src: assetUrl(source.src, `${path}.src`), alt } : { asset: parseAssetReference(source.asset, `${path}.asset`), alt };
}
/** 公開メタ情報を検証して新しいオブジェクトを返す。false・空配列は保存しない。 */
export function parsePageMeta(input: unknown, path = "$.meta"): PageMeta {
  const source = record(input, path), result: PageMeta = {};
  keys(source, ["description", "ogImage", "favicon", "noindex", "structuredData"], path);
  if (source.description !== undefined) result.description = line(source.description, `${path}.description`, metaLimits.descriptionLength);
  if (source.ogImage !== undefined) result.ogImage = parsePageImage(source.ogImage, `${path}.ogImage`);
  if (source.favicon !== undefined) result.favicon = assetUrl(source.favicon, `${path}.favicon`);
  if (source.noindex !== undefined) {
    if (typeof source.noindex !== "boolean") fail(`${path}.noindex`, "expected boolean");
    if (source.noindex) result.noindex = true;
  }
  if (source.structuredData !== undefined) {
    const at = `${path}.structuredData`;
    if (!Array.isArray(source.structuredData) || source.structuredData.length > metaLimits.structuredData) fail(at, "expected an ID array within limits");
    const ids = Array.from(source.structuredData as unknown[], (id, index) => identifier(id, `${at}[${index}]`));
    if (new Set(ids).size !== ids.length) fail(at, "duplicate ID");
    if (ids.length) result.structuredData = ids;
  }
  return result;
}

/** @internal インスタンスの検証に使う部品の外形（外枠のタグと公開 props の field）。 */
export type ComponentShape = { readonly tag: ElementTag; readonly props: ReadonlyMap<string, ComponentPropField> };
/** @internal 文書の body と部品の root で共有する検証状態。ノード数と文字数は usage へ合算する。 */
export type NodeContext = {
  readonly blocks: BlockContracts;
  readonly tokens: Record<string, DesignToken>;
  /** インスタンスの style は部品ライブラリと文書の tokens を重ねて検証する。 */
  readonly instanceTokens: Record<string, DesignToken>;
  /** 文書の文字スタイル。部品の root では持たない。 */
  readonly textStyles?: Readonly<Record<string, TextStyle>>;
  readonly components: ReadonlyMap<string, ComponentShape> | undefined;
  readonly ids: Set<string>;
  readonly htmlIds: Set<string>;
  readonly formLabels: Map<string, string>;
  readonly formControls: { id?: string; accessibleName?: string; path: string }[];
  readonly usage: { nodes: number; text: number };
};
/** @internal form control と label の文書全体参照を検査する。 */
export function validateFormReferences(context: NodeContext): void {
  for (const control of context.formControls) {
    if (!control.accessibleName && (!control.id || !context.formLabels.has(control.id))) fail(control.path, "form control requires an accessible label");
  }
  for (const [id, path] of context.formLabels) if (!context.formControls.some((control) => control.id === id)) fail(path, "label target is not a form control");
}
/** @internal */
export const reservedPropNames: readonly string[] = ["__proto__", "prototype", "constructor"];
/** @internal */
export const isElementTag = (value: unknown): value is ElementTag => typeof value === "string" && tags.has(value);
/** @internal */
export function componentShapes(library: ComponentLibrary): Map<string, ComponentShape> {
  return new Map(library.components.map((component): [string, ComponentShape] =>
    [component.id, { tag: component.root.tag, props: new Map(Object.entries(component.props ?? {}).map(([name, prop]) => [name, prop.field])) }]));
}
function instanceProps(value: unknown, shape: ComponentShape, path: string): { props?: Record<string, string> } {
  if (value === undefined) return {};
  const source = record(value, path), props: Record<string, string> = {};
  if (Object.keys(source).length > COMPONENT_LIMITS.instanceProps) fail(path, "too many instance props");
  for (const [name, raw] of Object.entries(source)) {
    identifier(name, path);
    if (reservedPropNames.includes(name)) fail(path, "reserved prop name");
    // 公開をやめた名前の値も保持するため、文字列としてだけ検証する。
    const field = shape.props.get(name), at = `${path}.${name}`;
    if (field === "href" || field === "src") {
      if (field === "href") {
        if (!isSafePublicLink(raw)) fail(at, "unsafe URL");
      } else if (!isSafePublicUrl(raw)) fail(at, "unsafe URL");
      props[name] = raw;
    } else props[name] = string(raw, at, field === "alt" ? 2048 : 4096);
  }
  return { props };
}
const nonBlank = (value: unknown) => typeof value === "string" && value.length <= 200 && !!value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
/** @internal registry は信頼できるコードだが、selector と UI に出す slot 宣言の形だけは確かめる。 */
export function blockSlots(contract: BlockContract, at: string): Readonly<Record<string, BlockSlot>> {
  const slots = contract.slots ?? {};
  for (const [name, slot] of Object.entries(slots)) {
    const textProp = slot.text === undefined || Object.hasOwn(contract.props, slot.text) && contract.props[slot.text]!.type === "string";
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(name) || reservedPropNames.includes(name) || !nonBlank(slot.label) || !textProp ||
        slot.style !== undefined && (!Array.isArray(slot.style) || !slot.style.every(isStyleProperty)) ||
        slot.data !== undefined && (!nonBlank(slot.data.reason) || !nonBlank(slot.data.source))) fail(`${at}.block`, "invalid block slot contract");
  }
  return slots;
}
/** 宣言された領域に、その領域で許可されたプロパティだけを指定できる。 */
function slotStyles(value: unknown, contract: BlockContract, tokens: Record<string, DesignToken>, at: string): { slots?: Record<string, NodeStyle> } {
  const declared = blockSlots(contract, at);
  if (value === undefined) return {};
  const source = record(value, `${at}.slots`), slots: Record<string, NodeStyle> = {};
  for (const [name, raw] of Object.entries(source)) {
    const path = `${at}.slots.${name}`;
    if (!Object.hasOwn(declared, name)) fail(path, "unknown block slot");
    // 状態・登場・幅別の非表示・文字スタイルは領域では使えない。
    const style = parseStyle(raw, tokens, path, {}, false), allowed: readonly string[] = declared[name]!.style ?? [];
    for (const declarations of [style.base ?? {}, ...(style.responsive ?? []).map((entry) => entry.declarations)]) {
      if (Object.keys(declarations).some((property) => !allowed.includes(property))) fail(path, "style not allowed in this slot");
    }
    slots[name] = style;
  }
  return { slots };
}

/** @internal 文書の body と部品の root を同じ規則で検証し、新しいノードを返す。 */
export function parseNodes(input: unknown, path: string, context: NodeContext, depth = 0, parent?: string, insideLink = false, inline = false, insideForm = false, ancestorInteraction?: ElementInteraction["type"]): PageNode[] {
  if (!Array.isArray(input)) fail(path, "expected node array");
  if (depth > 48 || input.length > 5000) fail(path, "document exceeds limits");
  return input.map((raw, index) => parseNode(raw, `${path}[${index}]`, context, depth, parent, insideLink, inline, insideForm, ancestorInteraction));
}
/** @internal depth はノードを含む配列の深さ。 */
export function parseNode(raw: unknown, at: string, context: NodeContext, depth = 0, parent?: string, insideLink = false, inline = false, insideForm = false, ancestorInteraction?: ElementInteraction["type"]): PageNode {
  const node = record(raw, at), { blocks, tokens, ids, htmlIds, usage } = context;
  if (++usage.nodes > 5000) fail(at, "too many nodes");
  if (node.type === "text") {
    keys(node, ["type", "text"], at);
    const text = string(node.text, `${at}.text`, 100000);
    usage.text += text.length;
    if (usage.text > 1000000) fail(at, "too much text");
    if (["ul", "ol", "dl", "picture", "select"].includes(parent ?? "") && text.trim()) fail(at, "text not allowed in this parent");
    return { type: "text", text };
  }
  if (node.type === "instance" && !context.components) fail(at, "component instance requires a component library");
  if (node.type !== "element" && node.type !== "component" && node.type !== "instance") fail(`${at}.type`, "unknown node type");
  keys(node, node.type === "element" ? ["type", "id", "tag", "asset", "icon", "embed", "interaction", "attrs", "style", "children"] : node.type === "component" ? ["type", "id", "block", "props", "style", "slots"] : ["type", "id", "component", "props", "style"], at);
  const id = identifier(node.id, `${at}.id`);
  if (ids.has(id)) fail(`${at}.id`, "duplicate node ID");
  ids.add(id);
  const style = node.style === undefined ? {} : { style: parseStyle(node.style, node.type === "instance" ? context.instanceTokens : tokens, `${at}.style`, context.textStyles) };
  const constrainedParent = parent === "ul" || parent === "ol" ? ["li"] : parent === "dl" ? ["dt", "dd"] : parent === "picture" ? ["source", "img"] : parent === "select" ? ["option"] : undefined;
  if (node.type === "instance") {
    const component = identifier(node.component, `${at}.component`), shape = context.components?.get(component);
    if (!shape) fail(`${at}.component`, "unknown component");
    // 展開後の root と同じ入れ子規則。内側の規則は展開後の文書で検証する。
    if (inline && !phrasing.has(shape.tag) || constrainedParent && !constrainedParent.includes(shape.tag) || insideLink && interactive.has(shape.tag) || shape.tag === "summary" && parent !== "details") fail(at, "invalid HTML content nesting");
    return { type: "instance", id, component, ...instanceProps(node.props, shape, `${at}.props`), ...style };
  }
  if (node.type === "component") {
    if (inline || constrainedParent) fail(at, "component requires a flow content parent");
    const block = identifier(node.block, `${at}.block`);
    if (!Object.hasOwn(blocks, block)) fail(`${at}.block`, "unregistered block");
    const contract = blocks[block]!;
    const sourceProps = record(node.props, `${at}.props`), props: Record<string, PublicPropValue> = {};
    keys(sourceProps, Object.keys(contract.props), `${at}.props`);
    for (const [name, rule] of Object.entries(contract.props)) {
      if (["__proto__", "prototype", "constructor", "key", "ref", "children", "dangerouslySetInnerHTML"].includes(name) || /^on/i.test(name)) fail(`${at}.props`, "unsafe prop contract");
      if (!Object.hasOwn(sourceProps, name)) {
        if (rule.required) fail(`${at}.props.${name}`, "required prop missing");
      } else props[name] = prop(sourceProps[name], rule, `${at}.props.${name}`);
    }
    return { type: "component", id, block, props, ...style, ...slotStyles(node.slots, contract, tokens, at) };
  }
  if (!isElementTag(node.tag)) fail(`${at}.tag`, "unsupported element");
  const tag = node.tag;
  if (inline && !phrasing.has(tag) || constrainedParent && !constrainedParent.includes(tag) || insideLink && interactive.has(tag)) fail(at, "invalid HTML content nesting");
  if (tag === "form" && insideForm) fail(at, "forms cannot be nested");
  if (["label", "input", "textarea", "select", "button", "fieldset"].includes(tag) && !insideForm && !(tag === "button" && ancestorInteraction === "video-toggle")) fail(at, "form control requires a form parent");
  if (tag === "option" && parent !== "select") fail(at, "option requires select parent");
  if (tag === "legend" && parent !== "fieldset") fail(at, "legend requires fieldset parent");
  if (tag === "summary" && parent !== "details") fail(at, "summary must be the first child of details");
  if (node.asset !== undefined && tag !== "img" && tag !== "video") fail(`${at}.asset`, "only img or video can reference an asset");
  if (node.icon !== undefined && (tag !== "span" || !isIconName(node.icon))) fail(`${at}.icon`, "unsupported built-in icon");
  if (node.embed !== undefined && tag !== "div") fail(`${at}.embed`, "only div can contain a standard embed");
  let interaction: { interaction?: ElementInteraction } = {};
  if (node.interaction !== undefined) {
    const descriptor = record(node.interaction, `${at}.interaction`);
    if (tag !== "div" || node.asset !== undefined || node.icon !== undefined || node.embed !== undefined || ancestorInteraction === "loop-box") fail(`${at}.interaction`, "unsupported interaction descriptor");
    if (descriptor.type === "video-toggle") {
      keys(descriptor, ["type"], `${at}.interaction`);
      interaction = { interaction: { type: "video-toggle" } };
    } else if (descriptor.type === "loop-box") {
      keys(descriptor, ["type", "speed", "pauseOnHover"], `${at}.interaction`);
      if (typeof descriptor.speed !== "number" || !Number.isFinite(descriptor.speed) || descriptor.speed < 0 || descriptor.speed > 1000) fail(`${at}.interaction.speed`, "speed must be between 0 and 1000 px/sec");
      if (typeof descriptor.pauseOnHover !== "boolean") fail(`${at}.interaction.pauseOnHover`, "expected boolean");
      interaction = { interaction: { type: "loop-box", speed: descriptor.speed, pauseOnHover: descriptor.pauseOnHover } };
    } else fail(`${at}.interaction`, "unsupported interaction descriptor");
  }
  const asset = node.asset === undefined ? {} : { asset: parseAssetReference(node.asset, `${at}.asset`) };
  const icon = node.icon === undefined ? {} : { icon: node.icon };
  const embed = node.embed === undefined ? {} : { embed: parseEmbedDescriptor(node.embed, `${at}.embed`) };
  const attrs = node.attrs === undefined ? {} : { attrs: attributes(node.attrs, tag, `${at}.attrs`, !!asset.asset) };
  const htmlId = attrs.attrs?.id;
  if (typeof htmlId === "string") {
    if (htmlIds.has(htmlId)) fail(`${at}.attrs.id`, "duplicate HTML ID");
    htmlIds.add(htmlId);
  }
  if (tag === "label" && typeof attrs.attrs?.htmlFor === "string") context.formLabels.set(attrs.attrs.htmlFor, `${at}.attrs.htmlFor`);
  if (["input", "textarea", "select"].includes(tag) && !(tag === "input" && attrs.attrs?.type === "submit")) context.formControls.push({
    ...(typeof htmlId === "string" ? { id: htmlId } : {}),
    ...([attrs.attrs?.["aria-label"], attrs.attrs?.title].find((value) => typeof value === "string" && value.trim()) ? { accessibleName: String([attrs.attrs?.["aria-label"], attrs.attrs?.title].find((value) => typeof value === "string" && value.trim())) } : {}), path: at
  });
  if (tag === "img" && !attrs.attrs) fail(at, "img requires attributes");
  if (tag === "video" && !attrs.attrs) fail(at, "video requires attributes");
  if (node.icon !== undefined && (attrs.attrs?.role !== "img" || typeof attrs.attrs["aria-label"] !== "string" || !attrs.attrs["aria-label"].trim() || attrs.attrs["aria-hidden"] === "true")) fail(at, "icon requires role img and aria-label");
  const children = parseNodes(node.children, `${at}.children`, context, depth + 1, tag, insideLink || interactive.has(tag) && tag !== "details", inline || phrasingParents.has(tag), insideForm || tag === "form", interaction.interaction?.type ?? ancestorInteraction);
  if (voidTags.has(tag) && children.length) fail(at, "void element cannot have children");
  if ((tag === "video" || node.icon !== undefined || node.embed !== undefined) && children.length) fail(at, "media element cannot have children");
  if (tag === "label" && !children.some((child) => child.type === "text" ? !!child.text.trim() : true)) fail(at, "label requires text");
  if (tag === "button" && !children.some((child) => child.type === "text" ? !!child.text.trim() : true) && typeof attrs.attrs?.["aria-label"] !== "string") fail(at, "button requires an accessible caption");
  if (tag === "option" && (!children.length || children.some((child) => child.type !== "text") || !children.some((child) => child.type === "text" && child.text.trim()))) fail(at, "option requires text");
  if (tag === "select" && !children.some((child) => child.type === "element" && child.tag === "option")) fail(at, "select requires options");
  if (tag === "fieldset") {
    const legends = children.flatMap((child, index) => child.type === "element" && child.tag === "legend" ? [index] : []);
    if (legends.length !== 1 || legends[0] !== 0) fail(`${at}.children`, "fieldset requires one first legend");
    const radios = children.filter((child): child is ElementNode => child.type === "element" && child.tag === "input" && child.attrs?.type === "radio");
    if (!radios.length || children.slice(1).some((child) => child.type !== "element" || child.tag !== "label" && !(child.tag === "input" && child.attrs?.type === "radio")) ||
        radios.some((radio) => radio.attrs?.name !== attrs.attrs?.name)) fail(`${at}.children`, "fieldset requires one named radio group");
  }
  if (tag === "details") {
    const summaries = children.flatMap((child, index) => (child.type === "element" ? child.tag : child.type === "instance" ? context.components!.get(child.component)!.tag : "") === "summary" ? [index] : []);
    if (summaries.length > 1 || summaries.length === 1 && summaries[0] !== 0) fail(`${at}.children`, "summary must be the first child of details");
  }
  if (tag === "picture") {
    const childTags = children.flatMap((child) => child.type === "element" ? [child.tag] : child.type === "instance" ? [context.components!.get(child.component)!.tag] : []);
    if (childTags[childTags.length - 1] !== "img" || childTags.filter((childTag) => childTag === "img").length !== 1) {
      fail(`${at}.children`, "picture requires source elements followed by one img");
    }
  }
  if (interaction.interaction?.type === "video-toggle") {
    const [video, button] = children;
    if (children.length !== 2 || video?.type !== "element" || video.tag !== "video" || button?.type !== "element" || button.tag !== "button" ||
        video.attrs?.controls === false || button.attrs?.type !== "button" || button.children.length !== 1 || button.children[0]?.type !== "text") fail(`${at}.children`, "video-toggle requires one controlled video followed by one text button");
  }
  if (interaction.interaction?.type === "loop-box" && !children.length) fail(`${at}.children`, "loop-box requires content");
  return { type: "element", id, tag, ...asset, ...icon, ...embed, ...interaction, ...attrs, ...style, children };
}

export type PageParseOptions = {
  /** parseComponentLibrary で検証済みの同じサイトのライブラリ。インスタンスを含む文書の検証に必須。 */
  components?: ComponentLibrary;
  /** 同じサイトの設定。継承値は返すページ JSON に混ぜない。 */
  siteStyles?: SiteStyles;
};
/**
 * 外部 JSON を検証し、未知フィールドを捨てずに拒否して新しい文書を返す。
 * インスタンスは展開せずに返すが、展開後の文書も検証し、その失敗は $.resolved 以下の位置で返す。
 */
export function parsePageDocument(input: unknown, blocks: BlockContracts = {}, options: PageParseOptions = {}): PageDocument {
  const source = record(input, "$"), library = options.components;
  keys(source, ["schemaVersion", "siteId", "pageId", "locale", "revision", "title", "meta", "tokens", "textStyles", "body"], "$");
  if (source.schemaVersion !== 1) fail("$.schemaVersion", "unsupported schema version");
  const siteId = identifier(source.siteId, "$.siteId"), pageId = identifier(source.pageId, "$.pageId");
  if (library && library.siteId !== siteId) fail("$.siteId", "component library belongs to another site");
  const locale = localeCode(source.locale, "$.locale");
  if (typeof source.revision !== "number" || !Number.isSafeInteger(source.revision) || source.revision < 1) fail("$.revision", "expected positive safe integer");
  const title = string(source.title, "$.title", 300);
  if (!title.trim()) fail("$.title", "title is required");
  const meta = source.meta === undefined ? {} : parsePageMeta(source.meta, "$.meta");
  const tokens = parseTokens(source.tokens, "$.tokens");
  const effectiveTokens = { ...parseSiteStyles(options.siteStyles ?? {}).tokens, ...tokens };
  const textStyles = source.textStyles === undefined ? undefined : parseTextStyles(source.textStyles, effectiveTokens, "$.textStyles");
  const effective = mergeSiteStyles({ tokens, ...(textStyles ? { textStyles } : {}) }, options.siteStyles);
  const context: NodeContext = {
    blocks, ...effective, instanceTokens: library ? { ...library.tokens, ...effective.tokens } : effective.tokens, components: library && componentShapes(library),
    ids: new Set(), htmlIds: new Set(), formLabels: new Map(), formControls: [], usage: { nodes: 0, text: 0 }
  };
  const document: PageDocument = { schemaVersion: 1, siteId, pageId, locale, revision: source.revision, title, ...(Object.keys(meta).length ? { meta } : {}), tokens, ...(textStyles ? { textStyles } : {}), body: parseNodes(source.body, "$.body", context) };
  validateFormReferences(context);
  if (library && instancesOf(document.body).length) {
    try {
      parsePageDocument(expandDocument(resolvePageStyles(document, options.siteStyles), library).document, blocks, options.siteStyles ? { siteStyles: options.siteStyles } : {});
    } catch (error) {
      if (error instanceof DocumentValidationError) throw new DocumentValidationError(`$.resolved${error.path.slice(1)}`, error.reason);
      throw error;
    }
  }
  return document;
}
