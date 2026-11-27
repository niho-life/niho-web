import { EDITING_OPERATIONS, SITE_STYLES_FEATURE, parseEditingApiDiscovery } from "../src/editing-api.js";

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Translate the one observed upstream discovery variant into the shared Studio contract. */
export function parseKamakuraEditingApiDiscovery(value: unknown, siteId: string, siteStylesRequested: boolean) {
  if (!plainRecord(value) || !Array.isArray(value.operations)) return parseEditingApiDiscovery(value, siteId);
  const pagesApplyPath = EDITING_OPERATIONS.find(({ id }) => id === "pages.apply")?.path;
  if (!pagesApplyPath) throw new TypeError("pages.apply is absent from the editing API catalog");
  const legacyPath = `${pagesApplyPath}&features=${SITE_STYLES_FEATURE}`;
  const operations = value.operations.map((operation) => plainRecord(operation) && operation.id === "pages.apply"
    && siteStylesRequested && operation.path === legacyPath
    ? { ...operation, path: pagesApplyPath }
    : operation);
  return parseEditingApiDiscovery({ ...value, operations }, siteId);
}
