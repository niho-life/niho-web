import { randomUUID } from "node:crypto";
import { link, mkdtemp, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseComponentLibrary } from "../dist/components.js";
import { parsePageDocument } from "../dist/document.js";
import { isEditingApiVersion } from "../dist/editing-client.js";
import { PAGE_OPERATION_ID } from "../dist/editing-page-operations.js";
import {
  analyzeNormalization, decodeNormalizationOperations, planNormalization, selectNormalizationOperations, verifyNormalization
} from "../dist/normalize.js";
import { parseSitePresentation } from "../dist/presentation.js";
import { parseSiteStyles } from "../dist/site-styles.js";
import { parseBreakpointSettings, removeBreakpointSetting } from "../dist/style-model.js";

const format = 1;
const timeout = () => AbortSignal.timeout(30_000);
const targetOf = ({ siteId, pageId, locale }) => ({ siteId, pageId, locale });
const targetKey = (target) => JSON.stringify([target.siteId, target.pageId, target.locale]);
const sourceOf = (value) => Object.hasOwn(value, "document") ? value : { document: value };

function shape(value, required, optional = []) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) throw new TypeError("invalid object fields");
}
function entries(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid object");
  return Object.values(value);
}
function version(value) {
  if (!isEditingApiVersion(value)) throw new TypeError("invalid version");
}
function checkedBlocks(blocks) {
  for (const block of entries(blocks)) {
    shape(block, ["props"], ["slots", "styleProperties", "lockedProps"]);
    for (const rule of entries(block.props)) {
      shape(rule, ["type"], ["required", "maxLength", "min", "max", "values"]);
      if (!["string", "number", "boolean", "url", "enum"].includes(rule.type)
        || rule.required !== undefined && typeof rule.required !== "boolean"
        || ["maxLength", "min", "max"].some((key) => rule[key] !== undefined && !Number.isFinite(rule[key]))
        || rule.type === "enum" && (!Array.isArray(rule.values) || rule.values.some((item) => typeof item !== "string"))) throw new TypeError("invalid rule");
    }
    for (const slot of entries(block.slots ?? {})) {
      shape(slot, ["label"], ["style", "text", "data"]);
      if (typeof slot.label !== "string" || slot.text !== undefined && typeof slot.text !== "string"
        || slot.style !== undefined && (!Array.isArray(slot.style) || slot.style.some((item) => typeof item !== "string"))) throw new TypeError("invalid slot");
      if (slot.data !== undefined) {
        shape(slot.data, ["reason", "source"]);
        if (entries(slot.data).some((item) => typeof item !== "string")) throw new TypeError("invalid slot data");
      }
    }
    if (block.styleProperties !== undefined && (!Array.isArray(block.styleProperties) || block.styleProperties.some((item) => typeof item !== "string"))
      || block.lockedProps !== undefined && entries(block.lockedProps).some((item) => typeof item !== "string")) throw new TypeError("invalid block styles");
  }
  return blocks;
}
function checkedInput(input) {
  shape(input, ["documents"], ["siteStyles", "siteStylesRevision", "components", "componentsVersion", "blocks", "breakpoints", "breakpointSettings"]);
  if (!Array.isArray(input.documents) || !input.documents.length) throw new TypeError("invalid documents");
  if (input.siteStylesRevision !== undefined) {
    shape(input.siteStylesRevision, ["stage", "version"]);
    if (!["draft", "published"].includes(input.siteStylesRevision.stage) || input.siteStyles === undefined) throw new TypeError("invalid style revision");
    version(input.siteStylesRevision.version);
  }
  if (input.componentsVersion !== undefined) {
    version(input.componentsVersion);
    if (input.components === undefined) throw new TypeError("missing components");
  }
  const blocks = input.blocks === undefined ? undefined : checkedBlocks(input.blocks);
  const components = input.components === undefined ? undefined : parseComponentLibrary(input.components, blocks);
  let siteStyles;
  if (input.siteStyles !== undefined) {
    shape(input.siteStyles, [], ["tokens", "textStyles"]);
    siteStyles = parseSiteStyles(input.siteStyles);
  }
  let breakpointSettings;
  if (input.breakpointSettings !== undefined) {
    shape(input.breakpointSettings, ["version", "settings"]);
    version(input.breakpointSettings.version);
    breakpointSettings = { version: input.breakpointSettings.version, settings: parseBreakpointSettings(input.breakpointSettings.settings) };
  }
  if (input.breakpoints !== undefined && (!Array.isArray(input.breakpoints) || input.breakpoints.some((width) => !Number.isSafeInteger(width) || width < 320 || width > 3840))) throw new TypeError("invalid breakpoints");
  const options = { ...(siteStyles ? { siteStyles } : {}), ...(components ? { components } : {}) };
  const documents = input.documents.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid document");
    if (!Object.hasOwn(value, "document")) return parsePageDocument(value, blocks, options);
    shape(value, ["document"], ["version", "componentsVersion", "presentationVersion", "presentation", "locks"]);
    for (const name of ["version", "componentsVersion", "presentationVersion"]) if (value[name] !== undefined) version(value[name]);
    if (value.locks !== undefined) {
      if (!Array.isArray(value.locks)) throw new TypeError("invalid locks");
      for (const lock of value.locks) {
        shape(lock, ["nodeId", "fields", "reason"]);
        if (typeof lock.nodeId !== "string" || typeof lock.reason !== "string" || !Array.isArray(lock.fields)
          || lock.fields.some((field) => typeof field !== "string")) throw new TypeError("invalid lock");
      }
    }
    const document = parsePageDocument(value.document, blocks, options);
    const presentation = value.presentation === undefined ? undefined : parseSitePresentation(value.presentation, document, blocks);
    if (value.presentationVersion !== undefined && presentation && presentation.version !== value.presentationVersion) throw new TypeError("invalid presentation version");
    return { ...value, document, ...(presentation ? { presentation } : {}) };
  });
  return { ...input, documents, ...(components ? { components } : {}), ...(siteStyles ? { siteStyles } : {}), ...(breakpointSettings ? { breakpointSettings } : {}) };
}

async function storeCheckpoint(path, checkpoint, initial, maximumBytes, fail) {
  const bytes = Buffer.from(`${JSON.stringify(checkpoint)}\n`);
  if (bytes.length > maximumBytes) fail("input_too_large");
  let directory;
  try {
    directory = await mkdtemp(join(dirname(path), ".niho-normalize-"));
    const staged = join(directory, "checkpoint.json");
    const file = await open(staged, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    if (initial) await link(staged, path);
    else await rename(staged, path);
  } catch (error) {
    if (initial && error?.code === "EEXIST") fail("normalization_checkpoint_exists", 409);
    fail("normalization_checkpoint_write_failed");
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

export async function runNormalizationCli(action, options, { client, scope, inputJson, maximumBytes, stableJson, fail, apiCall }) {
  const same = (a, b) => stableJson(a) === stableJson(b);
  // The planner's wire format drops undefined optional fields when serialized.
  const planFor = (input) => JSON.parse(JSON.stringify(planNormalization(input)));
  const readInput = (value) => {
    try { return checkedInput(value); }
    catch { fail("invalid_normalization_input", 400); }
  };
  if (action === "analyze" || action === "plan") {
    const input = readInput(await inputJson(options.json, maximumBytes));
    let result;
    try { result = action === "analyze" ? analyzeNormalization(input) : { input, plan: planFor(input) }; }
    catch { fail("invalid_normalization_input", 400); }
    if (action === "plan" && Buffer.byteLength(JSON.stringify(result)) + 1 > maximumBytes) fail("input_too_large");
    return result;
  }

  function bundleOf(value) {
    try { shape(value, ["input", "plan"]); } catch { fail("invalid_normalization_bundle", 400); }
    const input = readInput(value.input);
    let plan;
    try { plan = planFor(input); } catch { fail("invalid_normalization_input", 400); }
    if (!same(plan, value.plan)) fail("normalization_plan_mismatch", 409);
    if (plan.targets.some((target) => target.siteId !== scope.siteId || !isEditingApiVersion(target.version))) fail("normalization_target_version_required", 400);
    const revision = input.siteStylesRevision;
    const hasStyles = Object.keys(input.siteStyles?.tokens ?? {}).length || Object.keys(input.siteStyles?.textStyles ?? {}).length;
    if (revision?.stage === "published" || !revision && hasStyles) fail("normalization_draft_styles_required", 400);
    return { input, plan };
  }

  function selection(bundle, approvedProposalIds) {
    if (!Array.isArray(approvedProposalIds) || new Set(approvedProposalIds).size !== approvedProposalIds.length) fail("invalid_normalization_approval", 400);
    const selected = approvedProposalIds.map((id) => bundle.plan.proposals.find((proposal) => proposal.id === id));
    if (selected.some((proposal) => !proposal || !("operations" in proposal || "siteSettingsChanges" in proposal))) fail("invalid_normalization_approval", 400);
    let batches;
    try { batches = selectNormalizationOperations(bundle.plan, { approvedProposalIds }); }
    catch { fail("invalid_normalization_selection", 400); }
    const changes = selected.flatMap((proposal) => proposal.siteSettingsChanges ?? []);
    let settings;
    if (changes.length) {
      const initial = bundle.input.breakpointSettings;
      if (!initial || changes.some((change) => change.siteId !== scope.siteId || change.expectedVersion !== initial.version || !change.settings)
        || new Set(changes.map((change) => change.minWidth)).size !== changes.length) fail("invalid_normalization_breakpoint_selection", 400);
      let next = initial.settings;
      try {
        for (const { minWidth } of changes) {
          const removed = next.breakpoints.find((breakpoint) => breakpoint.minWidth === minWidth);
          next = removeBreakpointSetting(next, removed?.name);
        }
      } catch { fail("invalid_normalization_breakpoint_selection", 400); }
      settings = { initial, next };
    }
    if (!batches.length && !settings) fail("normalization_nothing_selected", 400);
    return { batches, settings };
  }

  const initial = action === "apply";
  const checkpointPath = resolve(initial ? options.checkpoint : options.json);
  let checkpoint, selected;
  if (initial) {
    const bundle = bundleOf(await inputJson(options.json, maximumBytes));
    const approvedProposalIds = options.approve ?? [];
    selected = selection(bundle, approvedProposalIds);
    checkpoint = { format, scope, bundle, approvedProposalIds, direction: "apply",
      pages: selected.batches.map(({ target }) => ({ target, operationId: randomUUID(), state: "pending" })),
      ...(selected.settings ? { breakpoints: { state: "pending" } } : {}) };
    // Leave room for the version and state of every confirmed write.
    const maximum = "x".repeat(200 * 6);
    const withProgress = { ...checkpoint, pages: checkpoint.pages.map((page) => ({ ...page, state: "restored", appliedVersion: maximum, restoredVersion: maximum })),
      ...(selected.settings ? { breakpoints: { state: "restored", appliedVersion: maximum, restoredVersion: maximum } } : {}) };
    if (Buffer.byteLength(JSON.stringify(withProgress)) + 1 > maximumBytes) fail("input_too_large");
    await storeCheckpoint(checkpointPath, checkpoint, true, maximumBytes, fail);
  } else {
    checkpoint = await inputJson(checkpointPath, maximumBytes);
    try { shape(checkpoint, ["format", "scope", "bundle", "approvedProposalIds", "direction", "pages"], ["breakpoints"]); }
    catch { fail("invalid_normalization_checkpoint", 400); }
    if (checkpoint.format !== format || !same(checkpoint.scope, scope)) fail("normalization_checkpoint_scope_mismatch", 409);
    checkpoint.bundle = bundleOf(checkpoint.bundle);
    selected = selection(checkpoint.bundle, checkpoint.approvedProposalIds);
    const states = ["pending", "sent", "applied", "restoring", "restored"];
    function step(value, page) {
      shape(value, page ? ["state", "operationId", "target"] : ["state"], ["appliedVersion", "restoredVersion"]);
      if (!states.includes(value.state) || ["applied", "restoring", "restored"].includes(value.state) !== isEditingApiVersion(value.appliedVersion)
        || (value.state === "restored") !== isEditingApiVersion(value.restoredVersion)
        || Object.hasOwn(value, "appliedVersion") && !isEditingApiVersion(value.appliedVersion)
        || Object.hasOwn(value, "restoredVersion") && !isEditingApiVersion(value.restoredVersion)
        || page && (typeof value.operationId !== "string" || !PAGE_OPERATION_ID.test(value.operationId))) throw new TypeError("invalid progress");
    }
    try {
      if (!["apply", "undo"].includes(checkpoint.direction) || !Array.isArray(checkpoint.pages) || checkpoint.pages.length !== selected.batches.length
        || Boolean(selected.settings) !== Object.hasOwn(checkpoint, "breakpoints")) throw new TypeError("invalid checkpoint");
      for (const [index, page] of checkpoint.pages.entries()) {
        step(page, true);
        if (!same(page.target, selected.batches[index].target)) throw new TypeError("wrong checkpoint target");
      }
      if (new Set(checkpoint.pages.map(({ operationId }) => operationId)).size !== checkpoint.pages.length) throw new TypeError("duplicate operation");
      if (selected.settings) step(checkpoint.breakpoints, false);
      const phases = [...checkpoint.pages, ...(selected.settings ? [checkpoint.breakpoints] : [])];
      if (checkpoint.direction === "apply" && phases.some(({ state }) => ["restoring", "restored"].includes(state))
        || checkpoint.direction === "undo" && phases.some(({ state }) => state === "sent")) throw new TypeError("invalid direction");
    } catch { fail("invalid_normalization_checkpoint", 400); }
  }
  let persisted = structuredClone(checkpoint);
  async function update() {
    const latest = await inputJson(checkpointPath, maximumBytes);
    if (!same(latest, persisted)) fail("normalization_checkpoint_conflict", 409);
    await storeCheckpoint(checkpointPath, checkpoint, false, maximumBytes, fail);
    persisted = structuredClone(checkpoint);
  }

  const { input, plan } = checkpoint.bundle;
  const styleRevision = input.siteStylesRevision;
  const draftStylesVersion = styleRevision?.version;
  const step = checkpoint.breakpoints;
  const { settings, batches } = selected;
  if (action === "resume" && checkpoint.direction !== "apply") fail("normalization_checkpoint_undo_started", 409);
  let currentStyles;
  try { currentStyles = await apiCall(() => client.readSiteStyles(timeout())); }
  catch (error) {
    if (error?.code !== "not_found") throw error;
  }
  if (Boolean(styleRevision) !== Boolean(currentStyles)) fail("normalization_draft_styles_required", 409);

  async function sendPage(page, batch) {
    page.state = "sent";
    await update();
    const { componentsVersion, presentationVersion, version: baseVersion } = page.target;
    const result = await apiCall(() => client.applyOperations(targetOf(page.target), {
      baseVersion, operationId: page.operationId, operations: decodeNormalizationOperations(batch.operations),
      ...(componentsVersion === undefined ? {} : { componentsVersion }),
      ...(presentationVersion === undefined ? {} : { presentationVersion }),
      ...(draftStylesVersion === undefined ? {} : { draftStylesVersion })
    }, timeout()));
    if (result.status === "conflict") {
      page.state = "pending";
      await update();
      return false;
    }
    if (result.status !== "applied") fail("invalid_response", 502);
    page.state = "applied";
    page.appliedVersion = result.version;
    await update();
    return true;
  }

  if (action === "resume" || action === "undo") {
    for (const [index, page] of checkpoint.pages.entries()) {
      if (page.state === "sent" && !await sendPage(page, batches[index]) && action === "resume") fail("version_conflict", 409);
    }
    if (step?.state === "sent") {
      const current = await apiCall(() => client.readBreakpointSettings(timeout()));
      if (current.version !== settings.initial.version && same(current.settings, settings.next)) {
        step.state = "applied";
        step.appliedVersion = current.version;
      } else if (current.version === settings.initial.version && same(current.settings, settings.initial.settings)) {
        step.state = "pending";
      } else {
        fail("version_conflict", 409);
      }
      await update();
    }
  }
  const applyComplete = checkpoint.pages.every(({ state }) => state === "applied") && (!step || step.state === "applied");
  if (styleRevision && (action !== "resume" || !applyComplete)
    && (currentStyles.draft.version !== draftStylesVersion || !same(currentStyles.draft.styles, input.siteStyles))) fail("version_conflict", 409);
  const originalByTarget = new Map(input.documents.map((entry) => {
    const { document } = sourceOf(entry);
    return [targetKey(document), document];
  }));
  const targetByIdentity = new Map(plan.targets.map((target) => [targetKey(target), target]));
  const parseOptions = { ...(input.components ? { components: input.components } : {}), ...(input.siteStyles ? { siteStyles: input.siteStyles } : {}) };
  async function readTarget(target) {
    const snapshot = await apiCall(() => client.read(targetOf(target), timeout()));
    if (draftStylesVersion === undefined && snapshot.draftStylesVersion !== undefined) fail("normalization_draft_styles_required", 409);
    if (snapshot.componentsVersion !== target.componentsVersion || snapshot.presentationVersion !== target.presentationVersion
      || snapshot.draftStylesVersion !== draftStylesVersion || !styleRevision && snapshot.stylesVersion !== undefined) fail("version_conflict", 409);
    try { return { ...snapshot, document: parsePageDocument(snapshot.document, input.blocks, parseOptions) }; }
    catch { fail("invalid_response", 502); }
  }
  function summary(status) {
    return { status, pages: checkpoint.pages, ...(checkpoint.breakpoints ? { breakpoints: checkpoint.breakpoints } : {}) };
  }
  if (action === "verify") {
    const current = [];
    for (const entry of input.documents) {
      const target = targetByIdentity.get(targetKey(sourceOf(entry).document));
      current.push((await readTarget(target)).document);
    }
    return verifyNormalization(input, current);
  }

  if (action === "undo") {
    if (checkpoint.direction !== "undo") {
      checkpoint.direction = "undo";
      await update();
    }
    if (step && ["applied", "restoring"].includes(step.state)) {
      const current = await apiCall(() => client.readBreakpointSettings(timeout()));
      if (step.state === "restoring" && current.version !== step.appliedVersion && same(current.settings, settings.initial.settings)) {
        step.restoredVersion = current.version;
      } else {
        if (current.version !== step.appliedVersion || !same(current.settings, settings.next)) fail("version_conflict", 409);
        step.state = "restoring";
        await update();
        const result = await apiCall(() => client.saveBreakpointSettings(step.appliedVersion, settings.initial.settings, timeout()));
        if (result.status === "conflict") fail("version_conflict", 409);
        if (result.version === step.appliedVersion) fail("invalid_response", 502);
        step.restoredVersion = result.version;
      }
      step.state = "restored";
      await update();
    }
    for (const page of [...checkpoint.pages].reverse()) {
      if (!["applied", "restoring"].includes(page.state)) continue;
      const target = targetOf(page.target);
      const original = originalByTarget.get(targetKey(target)), current = await readTarget(page.target);
      if (page.state === "restoring" && current.version !== page.appliedVersion
        && same({ ...current.document, revision: original.revision }, original)) {
        page.restoredVersion = current.version;
      } else {
        if (current.version !== page.appliedVersion) fail("version_conflict", 409);
        page.state = "restoring";
        await update();
        const result = await apiCall(() => client.save(target, page.appliedVersion, original, timeout(), draftStylesVersion));
        if (result.status === "conflict") fail("version_conflict", 409);
        if (result.version === page.appliedVersion) fail("invalid_response", 502);
        page.restoredVersion = result.version;
      }
      page.state = "restored";
      await update();
    }
    return summary("undone");
  }

  if (settings && step.state !== "applied") {
    const current = await apiCall(() => client.readBreakpointSettings(timeout()));
    if (current.version !== settings.initial.version || !same(current.settings, settings.initial.settings)) fail("version_conflict", 409);
  }
  const firstBatch = checkpoint.pages.every(({ state }) => state === "pending") && (!step || step.state === "pending");
  const pagesToCheck = initial || firstBatch ? plan.targets : checkpoint.pages.filter(({ state }) => state === "pending").map(({ target }) => target);
  for (const target of pagesToCheck) {
    const current = await readTarget(target);
    if (current.version !== target.version || !same(current.document, originalByTarget.get(targetKey(target)))) fail("version_conflict", 409);
  }
  for (const [index, page] of checkpoint.pages.entries()) {
    if (page.state === "applied") continue;
    if (!await sendPage(page, batches[index])) fail("version_conflict", 409);
  }
  if (settings && step.state !== "applied") {
    step.state = "sent";
    await update();
    const result = await apiCall(() => client.saveBreakpointSettings(settings.initial.version, settings.next, timeout()));
    if (result.status === "conflict") {
      step.state = "pending";
      await update();
      fail("version_conflict", 409);
    }
    if (result.version === settings.initial.version) fail("invalid_response", 502);
    step.state = "applied";
    step.appliedVersion = result.version;
    await update();
  }
  return summary("applied");
}
