import { elementAttributeNames, isElementTag, metaLimits, parsePageDocument } from "./document.js";
import { editDocumentById, walkNodes, type EditorOperationById } from "./editor-model.js";
import { diffDocuments, type DocumentChange } from "./history.js";
import { iconCatalog, isIconName } from "./icons.js";
import { MOTION_BASE_PROPERTIES } from "./builder.js";
import { appearEffects, easings, isStyleProperty, parseTokens, stateNames, stateProperties, stylePropertyNames, textStyleProperties } from "./style-values.js";
import { DocumentValidationError, fail, identifier, keys, parseAssetReference, record, string } from "./validation-utils.js";
import type { EditingActor, EditingPageSnapshot, EditingPageTarget, JsonSchema, PageEditingValidationContext } from "./editing-api.js";
import type { PageDocument } from "./types.js";

export const PAGE_OPERATION_LIMIT = 500;
export const PAGE_OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const PAGE_OPERATION_VERSIONS = ["componentsVersion", "presentationVersion", "stylesVersion"] as const;
export type PageOperationVersions = Readonly<Partial<Record<typeof PAGE_OPERATION_VERSIONS[number], string>>>;
export type EditingPageApplyInput = PageOperationVersions & {
  readonly baseVersion: string;
  readonly operationId: string;
  readonly operations: readonly EditorOperationById[];
  readonly dryRun?: boolean;
};
export type EditingPageApplied = { readonly status: "applied"; readonly version: string; readonly revision: number; readonly document: PageDocument };
export type EditingPageApplyResult = EditingPageApplied | { readonly status: "valid"; readonly diff: readonly DocumentChange[]; readonly touched: readonly string[] };
type ApplyRejection = { readonly status: "conflict" | "not_found" | "duplicate_operation" | "host_contract_violation" }
  | { readonly status: "validation_failed"; readonly index: number; readonly reason: string };
export type PageOperationJournal = {
  readonly actor: EditingActor;
  readonly target: EditingPageTarget;
  readonly input: Omit<EditingPageApplyInput, "dryRun" | "operations"> & { readonly operations: readonly PageOperationWire[] };
  readonly inputHash: string;
};
export type PageOperationTransaction = {
  readonly operationId: string;
  readonly inputHash: string;
  readonly dryRun: boolean;
  /** Execute against the page and its trusted validation context from the same versioned read. */
  prepare(snapshot: EditingPageSnapshot, validationContext: PageEditingValidationContext): ApplyRejection
    | Extract<EditingPageApplyResult, { status: "valid" }>
    | { readonly status: "ready"; readonly document: PageDocument; readonly journal: PageOperationJournal };
};
/**
 * Look up actor + operationId before checking versions. On 'ready', atomically CAS the page and
 * dependency versions, install the new page and journal pointers, and store hash and immutable
 * response. Retry a lost CAS through the lookup before reporting conflict. Dry runs never look
 * up or consume an operationId. No change is visible on any other decision.
 */
export type EditingPageOperationStore = {
  transact(actor: EditingActor, target: EditingPageTarget, transaction: PageOperationTransaction): Promise<EditingPageApplyResult | ApplyRejection>;
};

const text: JsonSchema = { type: "string" }, bool: JsonSchema = { type: "boolean" }, number: JsonSchema = { type: "number" };
const id: JsonSchema = { type: "string", maxLength: 80, pattern: "^[A-Za-z][A-Za-z0-9_-]*$" };
const indexSchema: JsonSchema = { type: "integer", minimum: 0, maximum: 5000 };
const widthSchema: JsonSchema = { type: "integer", minimum: 320, maximum: 3840 };
const hiddenMaxWidthSchema: JsonSchema = { type: "integer", minimum: 1, maximum: 3840 };
const version: JsonSchema = { type: "string", minLength: 1, maxLength: 200 };
const obj = (required: Readonly<Record<string, JsonSchema>>, optional: Readonly<Record<string, JsonSchema>> = {}) =>
  ({ type: "object" as const, required: Object.keys(required), properties: { ...required, ...optional }, additionalProperties: false });
const list = (items: JsonSchema, minItems: number, maxItems: number): JsonSchema => ({ type: "array", items, minItems, maxItems });
const either = (...oneOf: JsonSchema[]): JsonSchema => ({ oneOf });
const valuesOf = (values: readonly string[]): JsonSchema => ({ type: "string", enum: values });
const constant = (value: string | null): JsonSchema => ({ const: value });
const nullable = (schema: JsonSchema): JsonSchema => either(schema, constant(null));
const breakpoint = either(constant("base"), widthSchema);
const asset = obj({ provider: id, id: { type: "string", maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._~-]*$" } });
const styleValue = either(text, number, obj({ token: id }));
const styleMap = (names: readonly string[], value = styleValue): JsonSchema => obj({}, Object.fromEntries(names.map((name) => [name, value])));
const styleChanges: JsonSchema = { type: "object", additionalProperties: nullable(styleValue), propertyNames: valuesOf(stylePropertyNames) };
const textStyles = styleMap(textStyleProperties);
const appear = obj({ effect: valuesOf(appearEffects), trigger: valuesOf(["load", "view"]), duration: { type: "integer", minimum: 100, maximum: 3000 }, delay: { type: "integer", minimum: 0, maximum: 3000 } }, { easing: valuesOf(easings) });
const hidden = list(obj({ minWidth: either({ const: 0 }, widthSchema) }, { maxWidth: hiddenMaxWidthSchema }), 0, 12);
const motion = obj({}, { base: styleMap(MOTION_BASE_PROPERTIES), states: styleMap(stateNames, styleMap(stateProperties)), appear });
const booleanAttributes = ["controls", "loop", "muted", "playsInline", "required", "checked", "disabled"] as const;
const headingTags = ["p", "h1", "h2", "h3", "h4", "h5", "h6"] as const;
const tokenKinds = ["color", "length", "fontFamily", "number"] as const;
const primitive = either(text, number, bool);
const node = { $ref: "#/$defs/pageNode" };
const documentStyle = { $ref: "#/$defs/nodeStyle" };
const operation = (type: string, required: Record<string, JsonSchema> = {}, optional: Record<string, JsonSchema> = {}) => obj({ type: constant(type), ...required }, optional);
const nodeOperation = (type: string, required: Record<string, JsonSchema> = {}, optional: Record<string, JsonSchema> = {}) => operation(type, { nodeId: id, ...required }, optional);
const metaSchemas = {
  description: text, ogImage: either(obj({ src: text, alt: text }), obj({ asset, alt: text })), favicon: text, noindex: bool,
  targetReviewBeforePublish: bool, structuredData: list(id, 0, metaLimits.structuredData)
};
const nodeBaseStyle: JsonSchema = { type: "object", additionalProperties: either(styleValue, obj({ asset })), propertyNames: valuesOf([...stylePropertyNames, "backgroundImage"]) };
const responsive = (declarations: JsonSchema) => list(obj({ minWidth: widthSchema, declarations }), 0, 12);
export const pageApplyInputSchema: JsonSchema = {
  ...obj({
    baseVersion: version,
    operationId: { type: "string", pattern: PAGE_OPERATION_ID.source.replaceAll("a-f", "a-fA-F").replace("[89ab]", "[89abAB]") },
    operations: list({ $ref: "#/$defs/editorOperationById" }, 1, PAGE_OPERATION_LIMIT)
  }, { dryRun: bool, componentsVersion: version, presentationVersion: version, stylesVersion: version }),
  $defs: {
    editorOperationById: either(
      operation("text", { parentId: nullable(id), childPath: list(indexSchema, 1, 49), value: text }),
      nodeOperation("attribute", { name: valuesOf(elementAttributeNames), value: text }), nodeOperation("booleanAttribute", { name: valuesOf(booleanAttributes), value: bool }),
      nodeOperation("formChoices", { values: list(text, 1, 20) }), nodeOperation("formCompletionPage", {}, { pageId: id }),
      nodeOperation("icon", { name: valuesOf(iconCatalog.map(({ name }) => name)) }), nodeOperation("tag", { value: valuesOf(headingTags) }),
      nodeOperation("prop", { name: text }, { value: primitive }), nodeOperation("instanceProp", { name: text }, { value: text }),
      nodeOperation("style", { breakpoint, property: valuesOf(stylePropertyNames) }, { value: styleValue }),
      nodeOperation("styles", { breakpoint, values: styleChanges }), nodeOperation("styleRange", { breakpoint, until: widthSchema, values: styleChanges }),
      nodeOperation("resize", { breakpoint, width: number, height: number }, { until: widthSchema }),
      operation("token", { name: id, token: obj({ type: valuesOf(tokenKinds), value: either(text, number) }, { label: text }) }),
      operation("textStyle", { name: id, style: obj({ base: textStyles }, { label: text, responsive: responsive(textStyles) }) }),
      nodeOperation("nodeTextStyle", {}, { name: id, detach: bool }),
      nodeOperation("state", { state: valuesOf(stateNames), values: styleMap(stateProperties, nullable(styleValue)) }, { also: list(valuesOf(stateNames), 0, 3) }),
      nodeOperation("appear", {}, { value: appear }), nodeOperation("motionPreset", {}, { style: motion, previous: motion }),
      nodeOperation("hidden", {}, { ranges: hidden }), operation("title", { value: text }),
      operation("add", { parentId: nullable(id), node }, { index: indexSchema }),
      operation("addMany", { parentId: nullable(id), nodes: list(node, 1, 5000) }, { index: indexSchema }),
      nodeOperation("image", { source: either(obj({ asset }), obj({ src: text }, { srcset: text })) }, { alt: text }),
      nodeOperation("video", { source: either(obj({ asset }), obj({ src: text })) }),
      nodeOperation("embedSource", { source: text }), nodeOperation("embedTitle", { title: text }), nodeOperation("loopBox", { speed: number, pauseOnHover: bool }),
      nodeOperation("background", { breakpoint }, { asset }), nodeOperation("duplicate"), nodeOperation("remove"),
      nodeOperation("move", { parentId: nullable(id), index: indexSchema }), nodeOperation("detach"),
      nodeOperation("slotStyle", { slot: id, breakpoint, property: valuesOf(stylePropertyNames) }, { value: styleValue }),
      ...Object.entries(metaSchemas).map(([field, schema]) => operation("meta", { field: constant(field) }, { value: schema }))
    ),
    nodeStyle: obj({}, { base: nodeBaseStyle, responsive: responsive(nodeBaseStyle), textStyle: id, states: styleMap(stateNames, styleMap(stateProperties)), appear, hidden }),
    pageNode: either(
      obj({ type: constant("text"), text }),
      obj({ type: constant("element"), id, tag: text, children: list(node, 0, 5000) }, {
        style: documentStyle, attrs: { type: "object", additionalProperties: primitive, propertyNames: valuesOf(elementAttributeNames) }, asset, icon: valuesOf(iconCatalog.map(({ name }) => name)),
        formCompletionPageId: id, embed: obj({ provider: text, title: text }, { source: text }),
        interaction: either(obj({ type: constant("video-toggle") }), obj({ type: constant("loop-box"), speed: number, pauseOnHover: bool }))
      }),
      obj({ type: constant("component"), id, block: id, props: { type: "object", additionalProperties: primitive } }, { style: documentStyle, slots: { type: "object", additionalProperties: documentStyle } }),
      obj({ type: constant("instance"), id, component: id }, { style: documentStyle, props: { type: "object", additionalProperties: text } })
    )
  }
};
export function pageApplyResultSchema(document: JsonSchema): JsonSchema {
  return either(
    obj({ status: constant("applied"), version, revision: { type: "integer", minimum: 1 }, document }),
    obj({ status: constant("valid"), diff: list(obj({ path: text, before: text, after: text }), 0, 301), touched: list(id, 0, 10000) })
  );
}

type Check = (value: unknown, path: string) => unknown;
const oneOf = (values: readonly string[]): Check => (value, path) => {
  if (typeof value !== "string" || !values.includes(value)) fail(path, "unexpected value");
};
const finite: Check = (value, path) => { if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a finite number"); };
const boolean: Check = (value, path) => { if (typeof value !== "boolean") fail(path, "expected a boolean"); };
const integer = (min: number, max: number): Check => (value, path) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail(path, "integer out of range");
};
const index = integer(0, 5000), width = integer(320, 3840);
const checkBreakpoint: Check = (value, path) => { if (value !== "base") width(value, path); };
const checkParent: Check = (value, path) => { if (value !== null) identifier(value, path); };
const checkStyleProperty: Check = (value, path) => { if (!isStyleProperty(value)) fail(path, "unknown style property"); };
const checkStyleValue: Check = (value, path) => {
  if (typeof value === "string") string(value, path, 256);
  else if (typeof value === "number") finite(value, path);
  else shape(value, path, { token: identifier });
};
const checkLiteral: Check = (value, path) => {
  if (typeof value === "string") string(value, path, 100000);
  else if (typeof value !== "boolean") finite(value, path);
};
const array = (check: Check, min: number, max: number): Check => (value, path) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(path, "array length out of range");
  value.forEach((entry, at) => check(entry, `${path}[${at}]`));
};
function shape(value: unknown, path: string, required: Record<string, Check>, optional: Record<string, Check> = {}): void {
  const source = record(value, path);
  keys(source, [...Object.keys(required), ...Object.keys(optional)], path);
  for (const [key, check] of Object.entries(required)) check(source[key], `${path}.${key}`);
  for (const [key, check] of Object.entries(optional)) if (source[key] !== undefined) check(source[key], `${path}.${key}`);
}
const declarations = (property: Check, deletions = false): Check => (value, path) => {
  for (const [name, entry] of Object.entries(record(value, path))) {
    property(name, path);
    if (!(deletions && entry === null)) checkStyleValue(entry, `${path}.${name}`);
  }
};
const checkAppear: Check = (value, path) => shape(value, path, { effect: oneOf(appearEffects), trigger: oneOf(["load", "view"]), duration: integer(100, 3000), delay: integer(0, 3000) }, { easing: oneOf(easings) });
const checkHidden = array((value, path) => shape(value, path, { minWidth: (min, at) => { if (min !== 0) width(min, at); } }, { maxWidth: integer(1, 3840) }), 0, 12);
const checkStates: Check = (value, path) => shape(value, path, {}, Object.fromEntries(stateNames.map((name) => [name, declarations(oneOf(stateProperties))])));
const checkMotion: Check = (value, path) => shape(value, path, {}, { base: declarations(oneOf(MOTION_BASE_PROPERTIES)), states: checkStates, appear: checkAppear });
const checkTextStyle: Check = (value, path) => {
  const checkDeclarations = declarations(oneOf(textStyleProperties));
  shape(value, path, { base: checkDeclarations }, {
    label: string, responsive: array((entry, at) => shape(entry, at, { minWidth: width, declarations: checkDeclarations }), 0, 12)
  });
};
const checkImage: Check = (value, path) => shape(value, path, Object.hasOwn(record(value, path), "asset") ? { asset: parseAssetReference, alt: string } : { src: string, alt: string });
const checkSource = (image: boolean): Check => (value, path) => {
  if (Object.hasOwn(record(value, path), "asset")) shape(value, path, { asset: parseAssetReference });
  else shape(value, path, { src: string }, image ? { srcset: string } : {});
};
const checkNodeStyle: Check = (value, path) => {
  const checkBase: Check = (value, at) => {
    for (const [property, entry] of Object.entries(record(value, at))) {
      if (property === "backgroundImage") {
        if (entry !== "none") shape(entry, at, { asset: parseAssetReference });
      } else {
        checkStyleProperty(property, at);
        checkStyleValue(entry, at);
      }
    }
  };
  shape(value, path, {}, {
    base: checkBase, responsive: array((entry, at) => shape(entry, at, { minWidth: width, declarations: checkBase }), 0, 12),
    textStyle: identifier, states: checkStates, appear: checkAppear, hidden: checkHidden
  });
};
const dictionary = (check: Check, checkKey?: Check): Check => (value, path) => {
  for (const [key, entry] of Object.entries(record(value, path))) {
    checkKey?.(key, path);
    check(entry, `${path}.${key}`);
  }
};
const checkInteraction: Check = (value, path) => {
  const source = record(value, path);
  if (source.type === "video-toggle") shape(value, path, { type: oneOf(["video-toggle"]) });
  else shape(value, path, { type: oneOf(["loop-box"]), speed: finite, pauseOnHover: boolean });
};
function checkNode(value: unknown, path: string, depth = 0): void {
  if (depth > 48) fail(path, "document exceeds limits");
  const source = record(value, path), type = string;
  switch (source.type) {
    case "text": shape(value, path, { type, text: (text, at) => string(text, at, 100000) }); break;
    case "element": shape(value, path, {
      type, id: identifier, tag: (tag, at) => { if (!isElementTag(tag)) fail(at, "unsupported element"); }, children: array((child, at) => checkNode(child, at, depth + 1), 0, 5000)
    }, {
      style: checkNodeStyle, attrs: dictionary(checkLiteral, oneOf(elementAttributeNames)), asset: parseAssetReference,
      formCompletionPageId: identifier, icon: oneOf(iconCatalog.map(({ name }) => name)),
      embed: (entry, at) => shape(entry, at, { provider: string, title: string }, { source: (value, path) => string(value, path, 16384) }),
      interaction: checkInteraction
    }); break;
    case "component": shape(value, path, { type, id: identifier, block: identifier, props: dictionary(checkLiteral) }, { style: checkNodeStyle, slots: dictionary(checkNodeStyle) }); break;
    case "instance": shape(value, path, { type, id: identifier, component: identifier }, { style: checkNodeStyle, props: dictionary(string) }); break;
    default: fail(path, "unknown node type");
  }
}
const checkMeta: Record<string, Check> = {
  description: string, ogImage: checkImage, favicon: string, noindex: boolean, targetReviewBeforePublish: boolean, structuredData: array(identifier, 0, metaLimits.structuredData)
};

/** Wire shape checks are independent of the discoverable JSON Schema. Undefined map values travel as null. */
export function parsePageOperation(value: unknown, path: string): EditorOperationById {
  const source = record(value, path);
  const check = (required: Record<string, Check> = {}, optional: Record<string, Check> = {}) => shape(source, path, { type: string, ...required }, optional);
  const target = (required: Record<string, Check> = {}, optional: Record<string, Check> = {}) => check({ nodeId: identifier, ...required }, optional);
  switch (source.type) {
    case "text": check({ parentId: checkParent, childPath: array(index, 1, 49), value: (value, at) => string(value, at, 100000) }); break;
    case "title": check({ value: string }); break;
    case "meta": {
      if (typeof source.field !== "string" || !Object.hasOwn(checkMeta, source.field)) fail(path, "unknown metadata field");
      check({ field: string }, { value: checkMeta[source.field]! }); break;
    }
    case "attribute": target({ name: oneOf(elementAttributeNames), value: string }); break;
    case "booleanAttribute": target({ name: oneOf(booleanAttributes), value: boolean }); break;
    case "formChoices": target({ values: array(string, 1, 20) }); break;
    case "formCompletionPage": target({}, { pageId: identifier }); break;
    case "icon": target({ name: (value, at) => { if (!isIconName(value)) fail(at, "unknown icon"); } }); break;
    case "tag": target({ value: oneOf(headingTags) }); break;
    case "prop": target({ name: string }, { value: checkLiteral }); break;
    case "instanceProp": target({ name: string }, { value: string }); break;
    case "style": target({ breakpoint: checkBreakpoint, property: checkStyleProperty }, { value: checkStyleValue }); break;
    case "styles": target({ breakpoint: checkBreakpoint, values: declarations(checkStyleProperty, true) }); break;
    case "styleRange": target({ breakpoint: checkBreakpoint, until: width, values: declarations(checkStyleProperty, true) }); break;
    case "resize": target({ breakpoint: checkBreakpoint, width: finite, height: finite }, { until: width }); break;
    case "token": check({ name: identifier, token: (token, at) => parseTokens({ [String(source.name)]: token }, at) }); break;
    case "textStyle": check({ name: identifier, style: checkTextStyle }); break;
    case "nodeTextStyle": target({}, { name: identifier, detach: boolean }); break;
    case "state": target({ state: oneOf(stateNames), values: declarations(oneOf(stateProperties), true) }, { also: array(oneOf(stateNames), 0, 3) }); break;
    case "appear": target({}, { value: checkAppear }); break;
    case "hidden": target({}, { ranges: checkHidden }); break;
    case "motionPreset": target({}, { style: checkMotion, previous: checkMotion }); break;
    case "add": check({ parentId: checkParent, node: checkNode }, { index }); break;
    case "addMany": check({ parentId: checkParent, nodes: array(checkNode, 1, 5000) }, { index }); break;
    case "image": target({ source: checkSource(true) }, { alt: string }); break;
    case "video": target({ source: checkSource(false) }); break;
    case "embedSource": target({ source: (value, at) => string(value, at, 16384) }); break;
    case "embedTitle": target({ title: string }); break;
    case "loopBox": target({ speed: finite, pauseOnHover: boolean }); break;
    case "background": target({ breakpoint: checkBreakpoint }, { asset: parseAssetReference }); break;
    case "move": target({ parentId: checkParent, index }); break;
    case "slotStyle": target({ slot: identifier, breakpoint: checkBreakpoint, property: checkStyleProperty }, { value: checkStyleValue }); break;
    case "duplicate": case "remove": case "detach": target(); break;
    default: fail(path, "unsupported operation");
  }
  if (source.type === "styles" || source.type === "styleRange" || source.type === "state") {
    const values = Object.fromEntries(Object.entries(record(source.values, path)).map(([key, entry]) => [key, entry === null ? undefined : entry]));
    return { ...source, values } as EditorOperationById;
  }
  return source as EditorOperationById;
}

type MapOperation = Extract<EditorOperationById, { type: "styles" | "styleRange" | "state" }>;
type WireMapOperation<T extends MapOperation> = T extends MapOperation ? Omit<T, "values"> & { readonly values: Readonly<Partial<Record<keyof T["values"], Exclude<T["values"][keyof T["values"]], undefined> | null>>> } : never;
export type PageOperationWire = Exclude<EditorOperationById, MapOperation> | WireMapOperation<MapOperation>;
export function pageOperationWire(operation: EditorOperationById): PageOperationWire {
  if (operation.type === "styles" || operation.type === "styleRange" || operation.type === "state") {
    const values = Object.fromEntries(Object.entries(operation.values).map(([key, entry]) => [key, entry ?? null]));
    return { ...operation, values };
  }
  return operation;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return Object.fromEntries(entries.map(([key, entry]) => [key, canonical(entry)]));
}
export async function pageOperationHash(target: EditingPageTarget, input: Omit<EditingPageApplyInput, "dryRun">): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical({ target, ...input, operations: input.operations.map(pageOperationWire) })));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function editingOperationProblem(error: unknown, index: number): Extract<ApplyRejection, { status: "validation_failed" }> {
  return { status: "validation_failed", index, reason: error instanceof DocumentValidationError ? error.reason : error instanceof Error ? error.message : "invalid operation" };
}

export function changedPageNodeIds(before: PageDocument, after: PageDocument): string[] {
  const entries = (document: PageDocument) => new Map(walkNodes(document).flatMap(({ node, path }) => {
    if (node.type === "text") return [];
    const { children, ...rest } = node.type === "element" ? node : { ...node, children: undefined };
    return [[node.id, JSON.stringify([path, rest, children?.map((child) => child.type === "text" ? child.text : { id: child.id })])] as const];
  }));
  const old = entries(before), next = entries(after);
  return [...new Set([...old.keys(), ...next.keys()])].filter((id) => old.get(id) !== next.get(id));
}
export function preparePageOperations(snapshot: EditingPageSnapshot, context: PageEditingValidationContext, input: EditingPageApplyInput, journal: PageOperationJournal, dryRun: boolean): ReturnType<PageOperationTransaction["prepare"]> {
  if (snapshot.version !== input.baseVersion || PAGE_OPERATION_VERSIONS.some((name) => input[name] !== undefined && snapshot[name] !== input[name])) return { status: "conflict" };
  const options = { ...(context.components ? { components: context.components } : {}), ...(context.siteStyles ? { siteStyles: context.siteStyles } : {}) };
  let before: PageDocument;
  try { before = parsePageDocument(snapshot.document, context.blocks, options); }
  catch { return { status: "host_contract_violation" }; }
  if (before.siteId !== journal.target.siteId || before.pageId !== journal.target.pageId || before.locale !== journal.target.locale) return { status: "host_contract_violation" };
  let document = before, index = 0;
  try {
    for (const operation of input.operations) {
      document = editDocumentById(document, operation, context.blocks, context.locks, context.components, context.siteStyles);
      index++;
    }
    document = parsePageDocument(document, context.blocks, options);
  } catch (error) { return editingOperationProblem(error, Math.min(index, input.operations.length - 1)); }
  if (dryRun) return { status: "valid", diff: diffDocuments(before, document), touched: changedPageNodeIds(before, document) };
  return { status: "ready", document, journal };
}
